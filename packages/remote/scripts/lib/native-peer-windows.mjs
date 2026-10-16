import { execFileSync } from "node:child_process";

const WINDOWS_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

function windowsPowerShellEnv() {
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
  { pids = [], execFile = execFileSync } = {},
) {
  if (!files.length && !pids.length)
    return { acls: new Map(), procStarts: new Map() };
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acls = @(foreach ($p in $request.paths) {
  try {
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
        input: JSON.stringify({ paths: files, pids }),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: windowsPowerShellEnv(),
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

export function assertWindowsAcl(acl, kind, { privateMode = true } = {}) {
  const trusted = new Set([acl?.userSid, "S-1-5-18", "S-1-5-32-544"]);
  // 개별 쓰기·삭제·ACL 변경과 generic write/all을 함께 거른다.
  const writes =
    0x2 |
    0x4 |
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
    acl.reparsePoint !== false ||
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
