import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USER_SID = "S-1-5-21-1-2-3-1001";
export const OTHER_SID = "S-1-5-21-1-2-3-1002";
export const safeAcl = () => ({
  userSid: USER_SID,
  ownerSid: "S-1-5-32-544",
  reparsePoint: false,
  access: [USER_SID, "S-1-5-18", "S-1-5-32-544"].map((sid) => ({
    sid,
    rights: 2032127,
    type: "Allow",
    inheritanceFlags: 0,
    propagationFlags: 0,
  })),
});

export function windowsFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tfx-windows-peer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = (file) =>
    path.join(root, file.replaceAll(":", "").replaceAll("\\", "/"));
  const io = { ...fs };
  for (const method of [
    "lstatSync",
    "readFileSync",
    "writeFileSync",
    "mkdirSync",
    "readdirSync",
  ])
    io[method] = (file, ...args) => fs[method](local(file), ...args);
  const home = String.raw`C:\Users\example`;
  io.mkdirSync(home, { recursive: true });
  const overrides = new Map();
  const batches = [];
  const procStarts = new Map();
  const readWindowsState = (files, { pids }) => {
    batches.push({ files, pids });
    return {
      acls: new Map(
        files.map((file) => [file, overrides.get(file) || safeAcl()]),
      ),
      procStarts,
    };
  };
  return {
    home,
    platform: "win32",
    fs: io,
    readWindowsState,
    procStarts,
    overrides,
    batches,
  };
}
