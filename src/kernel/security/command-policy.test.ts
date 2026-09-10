/**
 * 命令策略（P2-1）单测 —— flag-aware 危险命令判定。
 */
import { describe, it, expect } from 'vitest';
import {
  parseCommandSegments,
  baseCommand,
  positionalArgs,
  isRootPath,
  hardDenyCheck,
  expandSegments,
} from './command-policy.js';

describe('parseCommandSegments / baseCommand', () => {
  it('按 && ; | 切段（引号感知）', () => {
    expect(parseCommandSegments('rm -rf / && echo done')).toEqual([
      ['rm', '-rf', '/'],
      ['echo', 'done'],
    ]);
    expect(parseCommandSegments("bash -c 'rm -rf /'; ls")).toEqual([
      ['bash', '-c', 'rm -rf /'],
      ['ls'],
    ]);
    expect(parseCommandSegments('a | b || c')).toEqual([['a'], ['b'], ['c']]);
  });

  it('baseCommand 跳过 sudo/env/VAR=/选项，剥离 .exe', () => {
    expect(baseCommand(['sudo', 'rm', '-rf', '/'])).toBe('rm');
    expect(baseCommand(['env', 'FOO=1', 'rm', '/'])).toBe('rm');
    expect(baseCommand(['FOO=1', 'npm', 'test'])).toBe('npm');
    expect(baseCommand(['RM.EXE', '-rf', '/'])).toBe('rm');
    expect(baseCommand(['-i', 'foo'])).toBe('foo');
  });
});

describe('positionalArgs（flag-aware）', () => {
  it('丢弃选项与选项值，保留位置参数', () => {
    expect(positionalArgs(['rm', '-r', '--', '/'])).toEqual(['/']);
    expect(positionalArgs(['git', '-c', 'a=b', 'push'])).toEqual(['push']);
    expect(positionalArgs(['rm', '-rf', '//'])).toEqual(['//']);
    expect(positionalArgs(['del', '/f', '/s', '/q', 'C:\\'])).toEqual(['C:\\']);
    expect(positionalArgs(['vssadmin', 'delete', 'shadows'])).toEqual(['delete', 'shadows']);
  });
});

describe('isRootPath', () => {
  it('根目录/盘根判定', () => {
    expect(isRootPath('/')).toBe(true);
    expect(isRootPath('//')).toBe(true);
    expect(isRootPath('C:\\')).toBe(true);
    expect(isRootPath('c:/')).toBe(true);
    expect(isRootPath('/home')).toBe(false);
    expect(isRootPath('./dist')).toBe(false);
  });
});

describe('hardDenyCheck（绕过形态全覆盖）', () => {
  it('旧正则能拦的仍拦', () => {
    expect(hardDenyCheck('rm -rf /')).not.toEqual([]);
    expect(hardDenyCheck('rm /')).not.toEqual([]);
    expect(hardDenyCheck('mkfs.ext4 /dev/sda1')).not.toEqual([]);
    expect(hardDenyCheck('dd if=/dev/sda of=disk.img')).not.toEqual([]);
    expect(hardDenyCheck('format c:')).not.toEqual([]);
    expect(hardDenyCheck('diskpart')).not.toEqual([]);
    expect(hardDenyCheck('bcdedit')).not.toEqual([]);
    expect(hardDenyCheck('vssadmin delete shadows')).not.toEqual([]);
    expect(hardDenyCheck('reg delete HKLM\\Software /f')).not.toEqual([]);
    expect(hardDenyCheck('cipher /w:C')).not.toEqual([]);
  });

  it('旧正则漏掉的绕过形态', () => {
    expect(hardDenyCheck('rm -r -- /')).not.toEqual([]);
    expect(hardDenyCheck('rm -rf //')).not.toEqual([]);
    expect(hardDenyCheck('sudo rm -rf /')).not.toEqual([]);
    expect(hardDenyCheck('rm.exe -rf /')).not.toEqual([]);
    expect(hardDenyCheck('del /f /s /q C:\\')).not.toEqual([]);
    expect(hardDenyCheck('rd /s /q D:/')).not.toEqual([]);
    expect(hardDenyCheck("Remove-Item -Recurse -Force 'C:\\'")).not.toEqual([]);
  });

  it('shell 包装穿透：bash -c / powershell -Command 内的危险命令', () => {
    expect(hardDenyCheck("bash -c 'rm -rf /'")).not.toEqual([]);
    expect(hardDenyCheck("sh -c 'dd if=/dev/sda'")).not.toEqual([]);
    expect(hardDenyCheck("powershell -Command \"Remove-Item -Recurse -Force 'C:\\'\"")).not.toEqual([]);
    expect(hardDenyCheck("cmd /c format c:")).not.toEqual([]);
  });

  it('合法命令不误杀', () => {
    expect(hardDenyCheck('rm -rf ./dist')).toEqual([]);
    expect(hardDenyCheck('rm file.txt')).toEqual([]);
    expect(hardDenyCheck('git push origin main')).toEqual([]);
    expect(hardDenyCheck('mkdir -p /tmp/foo')).toEqual([]);
    expect(hardDenyCheck('npm test')).toEqual([]);
    expect(hardDenyCheck('git -c core.hooksPath=/tmp push')).toEqual([]);
    expect(hardDenyCheck('format() { echo ok; }')).toEqual([]);
    expect(hardDenyCheck('del *.tmp')).toEqual([]);
  });
});

describe('expandSegments', () => {
  it('展开 shell 包装的嵌套命令', () => {
    const segs = expandSegments(parseCommandSegments("bash -c 'rm -rf /'"));
    expect(segs.length).toBe(2);
    expect(segs[1]).toEqual(['rm', '-rf', '/']);
  });
});
