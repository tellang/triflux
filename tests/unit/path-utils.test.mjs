import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  toPosixPath,
  toWindowsPath,
  normalizePath,
  resolveShellPath,
  detectShellType,
  isWslPath,
  isGitBashPath,
} from '../../hub/lib/path-utils.mjs';

describe('hub/lib/path-utils.mjs', () => {
  describe('toPosixPath', () => {
    it('Windows C: 경로를 POSIX로 변환한다', () => {
      assert.equal(toPosixPath('C:\\foo\\bar'), '/c/foo/bar');
    });

    it('Windows D: 경로를 POSIX로 변환한다', () => {
      assert.equal(toPosixPath('D:\\Users\\test'), '/d/Users/test');
    });

    it('드라이브 레터만 있는 경우 처리한다', () => {
      assert.equal(toPosixPath('C:\\'), '/c/');
    });

    it('이미 POSIX 경로면 그대로 반환한다', () => {
      assert.equal(toPosixPath('/usr/local/bin'), '/usr/local/bin');
    });

    it('forward slash가 섞인 Windows 경로도 처리한다', () => {
      assert.equal(toPosixPath('C:/foo/bar'), '/c/foo/bar');
    });

    it('null → 빈 문자열', () => {
      assert.equal(toPosixPath(null), '');
    });

    it('undefined → 빈 문자열', () => {
      assert.equal(toPosixPath(undefined), '');
    });

    it('빈 문자열 → 빈 문자열', () => {
      assert.equal(toPosixPath(''), '');
    });
  });

  describe('toWindowsPath', () => {
    it('Git Bash POSIX 경로를 Windows로 변환한다', () => {
      assert.equal(toWindowsPath('/c/foo/bar'), 'C:\\foo\\bar');
    });

    it('/d/ 경로를 Windows로 변환한다', () => {
      assert.equal(toWindowsPath('/d/Users/test'), 'D:\\Users\\test');
    });

    it('이미 Windows 경로면 그대로 반환한다 (슬래시 정규화 포함)', () => {
      assert.equal(toWindowsPath('C:\\foo\\bar'), 'C:\\foo\\bar');
    });

    it('Windows 경로에 forward slash가 있으면 backslash로 변환한다', () => {
      assert.equal(toWindowsPath('C:/foo/bar'), 'C:\\foo\\bar');
    });

    it('null → 빈 문자열', () => {
      assert.equal(toWindowsPath(null), '');
    });

    it('undefined → 빈 문자열', () => {
      assert.equal(toWindowsPath(undefined), '');
    });

    it('빈 문자열 → 빈 문자열', () => {
      assert.equal(toWindowsPath(''), '');
    });
  });

  describe('normalizePath', () => {
    it('win32 플랫폼에서 forward slash를 backslash로 변환한다', () => {
      const result = normalizePath('C:/foo/bar');
      if (process.platform === 'win32') {
        assert.equal(result, 'C:\\foo\\bar');
      } else {
        assert.equal(result, 'C:/foo/bar');
      }
    });

    it('비-Windows 플랫폼에서 backslash를 forward slash로 변환한다', () => {
      const result = normalizePath('foo\\bar\\baz');
      if (process.platform === 'win32') {
        assert.equal(result, 'foo\\bar\\baz');
      } else {
        assert.equal(result, 'foo/bar/baz');
      }
    });

    it('null → 빈 문자열', () => {
      assert.equal(normalizePath(null), '');
    });

    it('undefined → 빈 문자열', () => {
      assert.equal(normalizePath(undefined), '');
    });
  });

  describe('resolveShellPath', () => {
    it('git-bash: Windows 경로를 POSIX로 변환한다', () => {
      assert.equal(resolveShellPath('C:\\foo\\bar', 'git-bash'), '/c/foo/bar');
    });

    it('git-bash: 이미 POSIX면 그대로', () => {
      assert.equal(resolveShellPath('/usr/local', 'git-bash'), '/usr/local');
    });

    it('wsl: Windows 경로를 /mnt/ 형식으로 변환한다', () => {
      assert.equal(resolveShellPath('C:\\foo\\bar', 'wsl'), '/mnt/c/foo/bar');
    });

    it('wsl: Git Bash 경로를 /mnt/ 형식으로 변환한다', () => {
      assert.equal(resolveShellPath('/c/foo/bar', 'wsl'), '/mnt/c/foo/bar');
    });

    it('wsl: 이미 /mnt/ 경로면 그대로', () => {
      assert.equal(resolveShellPath('/mnt/c/foo/bar', 'wsl'), '/mnt/c/foo/bar');
    });

    it('cmd: POSIX 경로를 Windows로 변환한다', () => {
      assert.equal(resolveShellPath('/c/foo/bar', 'cmd'), 'C:\\foo\\bar');
    });

    it('powershell: POSIX 경로를 Windows로 변환한다', () => {
      assert.equal(resolveShellPath('/d/Users/test', 'powershell'), 'D:\\Users\\test');
    });

    it('null → 빈 문자열', () => {
      assert.equal(resolveShellPath(null, 'git-bash'), '');
    });
  });

  describe('detectShellType', () => {
    it('문자열을 반환한다', () => {
      const result = detectShellType();
      assert.equal(typeof result, 'string');
    });

    it('유효한 쉘 타입 중 하나를 반환한다', () => {
      const valid = new Set(['git-bash', 'wsl', 'cmd', 'powershell', 'unix']);
      assert.ok(valid.has(detectShellType()));
    });
  });

  describe('isWslPath', () => {
    it('/mnt/ 로 시작하면 true', () => {
      assert.equal(isWslPath('/mnt/c/foo/bar'), true);
    });

    it('/mnt/ 로 시작하지 않으면 false', () => {
      assert.equal(isWslPath('/c/foo/bar'), false);
    });

    it('Windows 경로는 false', () => {
      assert.equal(isWslPath('C:\\foo\\bar'), false);
    });

    it('null → false', () => {
      assert.equal(isWslPath(null), false);
    });

    it('undefined → false', () => {
      assert.equal(isWslPath(undefined), false);
    });
  });

  describe('isGitBashPath', () => {
    it('/c/... 패턴은 true', () => {
      assert.equal(isGitBashPath('/c/foo/bar'), true);
    });

    it('/d/... 패턴은 true', () => {
      assert.equal(isGitBashPath('/d/Users/test'), true);
    });

    it('/mnt/c/... 는 false (WSL 경로)', () => {
      assert.equal(isGitBashPath('/mnt/c/foo'), false);
    });

    it('/usr/local 같은 일반 POSIX 경로는 false', () => {
      assert.equal(isGitBashPath('/usr/local/bin'), false);
    });

    it('Windows 경로는 false', () => {
      assert.equal(isGitBashPath('C:\\foo\\bar'), false);
    });

    it('null → false', () => {
      assert.equal(isGitBashPath(null), false);
    });

    it('undefined → false', () => {
      assert.equal(isGitBashPath(undefined), false);
    });
  });
});
