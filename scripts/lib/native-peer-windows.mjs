import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";

const WINDOWS_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

function windowsStartupEnv() {
  // PowerShell 7의 모듈 경로를 빼서 Windows PowerShell 5.1이 기본값을 복원하게 한다.
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ["systemroot", "windir", "temp", "tmp", "userprofile"].includes(
        key.toLowerCase(),
      ),
    ),
  );
}

export function readWindowsPeerState(
  files,
  {
    pids = [],
    socketPath = null,
    junctionPaths = [],
    execFile = execFileSync,
  } = {},
) {
  if (!files.length && !pids.length)
    return { acls: new Map(), procStarts: new Map() };
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
if ($request.socketPath) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PeerSocketInfo {
  const uint ReadControlAndAttributes = 0x20080;
  const uint ShareReadWriteDelete = 7;
  const uint OpenExisting = 3;
  const uint OpenReparsePoint = 0x00200000;
  const uint BackupSemantics = 0x02000000;
  const int FileAttributeTagInfo = 9;
  const uint OwnerAndDacl = 5;
  const uint AfUnixTag = 0x80000023;
  const uint JunctionTag = 0xa0000003;
  const uint ReparsePoint = 0x400;
  const uint Directory = 0x10;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share,
      IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
      out ulong attributesAndTag, uint size);

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetKernelObjectSecurity(SafeFileHandle handle, uint information,
      [Out] byte[] buffer, uint length, out uint required);

  public static byte[] ReadSecurity(string path, bool socket, bool allowJunction, out bool junction) {
    using (var handle = CreateFile(path, ReadControlAndAttributes, ShareReadWriteDelete,
        IntPtr.Zero, OpenExisting, OpenReparsePoint | BackupSemantics, IntPtr.Zero)) {
      ulong info;
      if (handle.IsInvalid || !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out info, sizeof(ulong)))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      junction = allowJunction && (info >> 32) == JunctionTag &&
                 (info & (ReparsePoint | Directory)) == (ReparsePoint | Directory);
      if (socket ? (info >> 32) != AfUnixTag || (info & (ReparsePoint | Directory)) != ReparsePoint
                 : (info & ReparsePoint) != 0 && !junction)
        throw new InvalidOperationException("Unexpected Windows reparse point");
      uint length;
      GetKernelObjectSecurity(handle, OwnerAndDacl, null, 0, out length);
      if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      var descriptor = new byte[length];
      if (!GetKernelObjectSecurity(handle, OwnerAndDacl, descriptor, length, out length))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return descriptor;
    }
  }
}
'@
}
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$fixedDrives = @{}
$checkedPaths = @{}
$acls = @(foreach ($p in $request.paths) {
  try {
    if ($request.socketPath) {
      $root = [System.IO.Path]::GetPathRoot($p)
      if (!$fixedDrives.ContainsKey($root)) {
        $fixedDrives[$root] = ([System.IO.DriveInfo]::new($root).DriveType -eq [System.IO.DriveType]::Fixed)
      }
      if (!$fixedDrives[$root]) { throw 'Codex peer requires a local fixed drive' }
      $parent = [System.IO.Path]::GetDirectoryName($p)
      if ($parent -and !$checkedPaths.ContainsKey($parent)) { throw 'Cannot inspect Codex peer path before its parent' }
    }
    $isSocket = $p -ceq $request.socketPath
    if ($request.socketPath) {
      $junction = $false
      $allowJunction = $request.junctionPaths -ccontains $p
      $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new([PeerSocketInfo]::ReadSecurity($p, $isSocket, $allowJunction, [ref]$junction), 0)
      $unmapped = @($raw.DiscretionaryAcl | Where-Object { $_.AceType -notin 'AccessAllowed', 'AccessDenied' })
      if ($null -eq $raw.DiscretionaryAcl -or $unmapped.Count) { throw 'Unsupported Codex peer DACL' }
      if (!$junction) { $checkedPaths[$p] = $true }
      [pscustomobject]@{
        path = $p
        userSid = $userSid
        ownerSid = $raw.Owner.Value
        reparsePoint = $isSocket -or $junction
        unixSocket = $isSocket
        junction = $junction
        complete = $true
        access = @(foreach ($ace in $raw.DiscretionaryAcl) {
          [pscustomobject]@{
            sid = $ace.SecurityIdentifier.Value
            rights = [long]$ace.AccessMask
            type = if ($ace.AceType -eq 'AccessAllowed') { 'Allow' } else { 'Deny' }
            propagationFlags = if ([int]($ace.AceFlags) -band [int]([System.Security.AccessControl.AceFlags]::InheritOnly)) { 2 } else { 0 }
          }
        })
      }
      continue
    }
    $item = if ([System.IO.Directory]::Exists($p)) { [System.IO.DirectoryInfo]::new($p) } else { [System.IO.FileInfo]::new($p) }
    $acl = $item.GetAccessControl()
    [pscustomobject]@{
      path = $p
      userSid = $userSid
      ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
      reparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
      access = @(foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        [pscustomobject]@{
          sid = $rule.IdentityReference.Value
          rights = [long]$rule.FileSystemRights
          type = $rule.AccessControlType.ToString()
          inheritanceFlags = [int]$rule.InheritanceFlags
          propagationFlags = [int]$rule.PropagationFlags
        }
      })
    }
  } catch {
    [pscustomobject]@{ path = $p; error = $_.Exception.Message }
  }
})
$processes = @(foreach ($processId in $request.pids) {
  try {
    $start = [System.Diagnostics.Process]::GetProcessById($processId).StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
    [pscustomobject]@{ pid = $processId; procStart = $start }
  } catch {
    [pscustomobject]@{ pid = $processId; error = $_.Exception.Message }
  }
})
ConvertTo-Json -InputObject @{ acls = $acls; processes = $processes } -Depth 5 -Compress
`;
  const rows = JSON.parse(
    execFile(
      WINDOWS_POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        input: JSON.stringify({
          paths: files,
          pids,
          ...(socketPath && { socketPath, junctionPaths }),
        }),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: windowsStartupEnv(),
      },
    ),
  );
  if (!Array.isArray(rows.acls) || !Array.isArray(rows.processes))
    throw new Error("Invalid Windows peer response");
  return {
    acls: new Map(
      rows.acls
        .filter((row) => !Object.hasOwn(row, "error"))
        .map((row) => [row.path, row]),
    ),
    procStarts: new Map(
      rows.processes
        .filter(
          (row) =>
            !Object.hasOwn(row, "error") &&
            typeof row.procStart === "string" &&
            /^\d+$/.test(row.procStart),
        )
        .map((row) => [row.pid, row.procStart]),
    ),
  };
}

export function readWindowsAcls(files, options) {
  return readWindowsPeerState(files, options).acls;
}

export function assertWindowsAcl(
  acl,
  kind,
  {
    privateMode = true,
    codex = false,
    socket = false,
    junction = false,
    ancestor = false,
  } = {},
) {
  const trusted = new Set([acl?.userSid, "S-1-5-18", "S-1-5-32-544"]);
  if (codex) {
    // Windows가 관리하는 설치 경로의 TrustedInstaller SID다.
    trusted.add(
      "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    );
  }
  // 개별 쓰기, 삭제, ACL 변경과 generic write/all을 함께 거른다.
  const writes =
    (ancestor ? 0 : 0x2 | 0x4) |
    0x10 |
    0x40 |
    0x100 |
    0x10000 |
    0x40000 |
    0x80000 |
    0x40000000 |
    0x10000000;
  if (
    !/^S-1-\d+(?:-\d+)+$/.test(acl?.userSid || "") ||
    !trusted.has(acl.ownerSid) ||
    (socket
      ? acl.reparsePoint !== true || acl.unixSocket !== true
      : acl.reparsePoint !== junction || (junction && acl.junction !== true)) ||
    (codex &&
      (acl.complete !== true ||
        (privateMode && acl.ownerSid !== acl.userSid))) ||
    !Array.isArray(acl.access) ||
    !acl.access.length ||
    acl.access.some(
      (ace) =>
        !/^S-1-\d+(?:-\d+)+$/.test(ace.sid || "") ||
        !["Allow", "Deny"].includes(ace.type) ||
        !Number.isInteger(ace.rights) ||
        ace.rights < -2147483648 ||
        ace.rights > 0xffffffff ||
        (ace.type === "Allow" &&
          !(
            Number.isInteger(ace.propagationFlags) &&
            (ace.propagationFlags & 2) !== 0
          ) &&
          !trusted.has(ace.sid) &&
          (privateMode || (ace.rights & writes) !== 0)),
    )
  )
    throw new Error(`Unsafe ${kind}`);
}

function localPath(value, kind) {
  if (
    typeof value !== "string" ||
    !/^[a-z]:[\\/]/i.test(value) ||
    /[<>:"|?*\x00-\x1f]/.test(value.slice(2)) ||
    /[. ](?:[\\/]|$)/.test(value)
  )
    throw new Error(`Unsafe ${kind}: expected an absolute local Windows path`);
  return path.win32.normalize(value);
}

function parentPaths(file) {
  const parents = [];
  let dir = path.win32.dirname(file);
  for (;;) {
    parents.push(dir);
    const parent = path.win32.dirname(dir);
    if (parent === dir) return parents.reverse();
    dir = parent;
  }
}

export function resolveWindowsCodexProxy({
  home,
  env,
  arch = process.arch,
  fs: io = fs,
  readAcls = readWindowsAcls,
}) {
  const { basename, dirname, join } = path.win32;
  const codexHome = localPath(
    env.CODEX_HOME ?? join(home, ".codex"),
    "CODEX_HOME",
  );
  const socketPath = join(
    codexHome,
    "app-server-control",
    "app-server-control.sock",
  );
  const triple = {
    x64: "x86_64-pc-windows-msvc",
    arm64: "aarch64-pc-windows-msvc",
  }[arch];
  if (!triple) throw new Error("Unsupported Windows Codex architecture");
  const npmScope = join(
    localPath(env.APPDATA ?? join(home, "AppData", "Roaming"), "APPDATA"),
    "npm",
    "node_modules",
    "@openai",
  );
  const platformPackage = `codex-win32-${arch}`;
  const wrapper = join(npmScope, "codex", "package.json");
  const npmCandidates = [
    join(npmScope, "codex", "node_modules", "@openai", platformPackage),
    join(npmScope, platformPackage),
    join(npmScope, "codex"),
  ].map((dir) => ({
    executable: join(dir, "vendor", triple, "bin", "codex.exe"),
    manifest: join(dir, "package.json"),
  }));
  const standaloneCandidates = ["standalone", "app-server-daemon"].map(
    (install) => {
      const current = join(codexHome, "packages", install, "current");
      return { current, executable: join(current, "bin", "codex.exe") };
    },
  );
  const socketParents = parentPaths(socketPath);
  const installPaths = [...npmCandidates, ...standaloneCandidates].flatMap(
    ({ executable, manifest }) =>
      [executable, ...(manifest ? [manifest, wrapper] : [])].flatMap((file) => [
        ...parentPaths(file),
        file,
      ]),
  );
  const acls = readAcls(
    [...new Set([...socketParents, socketPath, ...installPaths])],
    {
      socketPath,
      junctionPaths: standaloneCandidates.map(({ current }) => current),
    },
  );
  if (!acls.has(socketParents[0]))
    throw new Error(
      "Cannot verify the local drive of the Windows Codex shared app-server",
    );
  if (!acls.has(socketPath))
    throw new Error(
      "Windows Codex shared app-server socket missing or unsafe. Start the user-owned shared daemon and attach the existing Codex session before sending",
    );
  for (const dir of socketParents) {
    const immediate = dir === path.win32.dirname(socketPath);
    assertWindowsAcl(acls.get(dir), "Codex app-server socket directory", {
      privateMode: immediate,
      codex: true,
      ancestor: !immediate,
    });
    if (!io.lstatSync(dir).isDirectory())
      throw new Error("Unsafe Codex app-server socket directory");
  }
  assertWindowsAcl(acls.get(socketPath), "Codex app-server socket", {
    codex: true,
    socket: true,
  });

  const releasePaths = [];
  const releaseName = new RegExp(
    `^[0-9]+\\.[0-9]+\\.[0-9]+(?:-alpha(?:\\.[0-9]+){0,2}|-beta(?:\\.[0-9]+)?)?-${triple}$`,
    "i",
  );
  const candidates = [
    ...npmCandidates,
    ...standaloneCandidates.flatMap(({ current, executable }) => {
      const acl = acls.get(current);
      if (!acl?.junction) return [{ executable }];
      try {
        assertWindowsAcl(acl, "Codex current junction", {
          privateMode: false,
          codex: true,
          junction: true,
        });
        // current의 직접 대상만 읽고 이후에는 물리 경로의 ACL을 검사한다.
        const target = localPath(
          io.readlinkSync(current),
          "Codex current junction",
        );
        const releases = join(dirname(current), "releases");
        const name = basename(target);
        if (
          dirname(target).toLowerCase() !== releases.toLowerCase() ||
          !releaseName.test(name)
        )
          throw new Error("Unsafe Codex current junction target");
        const release = join(releases, name);
        return [
          join(release, "bin", "codex.exe"),
          join(release, "codex.exe"),
        ].map((file) => {
          releasePaths.push(...parentPaths(file), file);
          return { executable: file, physicalRelease: true };
        });
      } catch (error) {
        return [{ error }];
      }
    }),
  ];

  let installError;
  let releaseAcls;
  for (const { executable, manifest, error, physicalRelease } of candidates) {
    if (error) {
      installError ??= error;
      continue;
    }
    const candidateAcls = physicalRelease
      ? (releaseAcls ??= readAcls([...new Set(releasePaths)], { socketPath }))
      : acls;
    if (!candidateAcls.has(executable)) continue;
    try {
      const files = manifest
        ? [...new Set([executable, manifest, wrapper])]
        : [executable];
      const installParents = [...new Set(files.flatMap(parentPaths))];
      for (const dir of installParents) {
        assertWindowsAcl(candidateAcls.get(dir), "Codex install directory", {
          privateMode: false,
          codex: true,
          ancestor: !files.some((file) => path.win32.dirname(file) === dir),
        });
        if (!io.lstatSync(dir).isDirectory())
          throw new Error("Unsafe Codex install directory");
      }
      for (const file of files) {
        assertWindowsAcl(candidateAcls.get(file), "Codex install file", {
          privateMode: false,
          codex: true,
        });
        if (!io.lstatSync(file).isFile())
          throw new Error("Unsafe Codex install file");
      }
      if (manifest) {
        const packageInfo = JSON.parse(io.readFileSync(wrapper, "utf8"));
        const native = JSON.parse(io.readFileSync(manifest, "utf8"));
        if (
          packageInfo.name !== "@openai/codex" ||
          native.name !== "@openai/codex" ||
          !/^\d+\.\d+\.\d+$/.test(packageInfo.version) ||
          (manifest !== wrapper &&
            (native.version !== `${packageInfo.version}-win32-${arch}` ||
              packageInfo.optionalDependencies?.[
                `@openai/${platformPackage}`
              ] !== `npm:@openai/codex@${native.version}`))
        )
          throw new Error(
            "Windows Codex npm native package does not match its CLI installation",
          );
      }
      return { socketPath, executable };
    } catch (error) {
      installError ??= error;
    }
  }
  throw (
    installError ??
    new Error(
      "Windows Codex native codex.exe missing from the supported npm or standalone install paths",
    )
  );
}

export function connectWindowsCodexProxy(
  executable,
  socketPath,
  spawnProxy = spawn,
) {
  const child = spawnProxy(
    executable,
    ["app-server", "proxy", "--sock", socketPath],
    {
      shell: false,
      windowsHide: true,
      cwd: path.win32.dirname(executable),
      env: windowsStartupEnv(),
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.once("spawn", () => stream.emit("connect"));
  child.once("error", (error) => stream.destroy(error));
  child.once("close", (code) => {
    if (code)
      stream.destroy(new Error(`Codex app-server proxy exited (${code})`));
  });
  stream.once("close", () => child.kill());
  return stream;
}
