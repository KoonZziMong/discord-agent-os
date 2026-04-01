/**
 * computer.ts — Anthropic Computer Use 툴 구현
 *
 * 외부 npm 네이티브 모듈 없이 macOS 내장 도구만 사용합니다.
 *   screenshot  : screencapture (macOS 내장)
 *   mouse/kbd   : Python3 Quartz (macOS 내장) + osascript
 *   bash        : child_process.exec
 *   text_editor : Node.js fs
 *
 * ⚠️ 마우스·키보드 제어는 macOS 설정 → 개인 정보 보호 → 손쉬운 사용에서
 *    Terminal(또는 봇 실행 앱)에 접근 권한을 허용해야 합니다.
 */
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);

// ── 타입 ──────────────────────────────────────────────────

/** 스크린샷 tool_result content 형식 */
export type ToolImageContent = [{
  type: 'image';
  source: { type: 'base64'; media_type: 'image/png'; data: string };
}];

/** Computer Use 툴이 반환할 수 있는 콘텐츠 */
export type ToolResultContent = string | ToolImageContent;

// ── 화면 크기 감지 ─────────────────────────────────────────

function detectDisplaySize(): { width: number; height: number } {
  try {
    const result = execSync(
      `python3 -c "import Quartz; b = Quartz.CGDisplayBounds(Quartz.CGMainDisplayID()); print(int(b.size.width), int(b.size.height))"`,
      { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' },
    ).trim();
    const [w, h] = result.split(' ').map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch {}
  return { width: 1920, height: 1080 };
}

/** 모듈 로드 시 1회 감지 */
export const DISPLAY_SIZE = detectDisplaySize();

// ── 내부 헬퍼 ─────────────────────────────────────────────

/** Python 코드를 임시 파일로 실행 (인라인 escaping 문제 방지) */
async function runPython(code: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `cu_py_${Date.now()}.py`);
  try {
    fs.writeFileSync(tmp, code, 'utf-8');
    const { stdout } = await execAsync(`python3 "${tmp}"`, { timeout: 10_000 });
    return stdout.trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** AppleScript를 임시 파일로 실행 */
async function runOsascript(script: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `cu_as_${Date.now()}.applescript`);
  try {
    fs.writeFileSync(tmp, script, 'utf-8');
    const { stdout } = await execAsync(`osascript "${tmp}"`, { timeout: 10_000 });
    return stdout.trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── 스크린샷 ───────────────────────────────────────────────

export async function screenshot(): Promise<ToolImageContent> {
  const tmp = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
  try {
    await execAsync(`screencapture -x "${tmp}"`);
    const data = fs.readFileSync(tmp);
    return [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } }];
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── 키보드 매핑 ────────────────────────────────────────────

const KEY_CODE: Record<string, number> = {
  Return: 36, Enter: 36,
  Tab: 48,
  space: 49,
  BackSpace: 51, Delete: 51,
  Escape: 53,
  Left: 123, ArrowLeft: 123,
  Right: 124, ArrowRight: 124,
  Down: 125, ArrowDown: 125,
  Up: 126, ArrowUp: 126,
  F1: 122, F2: 120, F3: 99, F4: 118,
  F5: 96, F6: 97, F7: 98, F8: 100,
  F9: 101, F10: 109, F11: 103, F12: 111,
  Home: 115, End: 119, PageUp: 116, PageDown: 121,
};

const MODIFIER: Record<string, string> = {
  ctrl: 'control down', control: 'control down',
  cmd: 'command down', super: 'command down', command: 'command down',
  alt: 'option down', option: 'option down',
  shift: 'shift down',
};

// ── computer tool ──────────────────────────────────────────

export interface ComputerInput {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  key?: string;
  scroll_direction?: string;
  scroll_distance?: number;
}

export async function computerAction(input: ComputerInput): Promise<ToolResultContent> {
  const { action, coordinate, text, key, scroll_direction, scroll_distance } = input;

  switch (action) {

    // ── 스크린샷 ──
    case 'screenshot':
      return screenshot();

    // ── 커서 위치 조회 ──
    case 'cursor_position': {
      const pos = await runPython(`
import Quartz
loc = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
print(int(loc.x), int(loc.y))
`);
      return `cursor: ${pos}`;
    }

    // ── 마우스 이동 ──
    case 'mouse_move': {
      const [x, y] = coordinate!;
      await runPython(`
import Quartz
Quartz.CGWarpMouseCursorPosition((${x}, ${y}))
`);
      return 'moved';
    }

    // ── 왼쪽 클릭 ──
    case 'left_click': {
      const [x, y] = coordinate!;
      await runPython(`
import Quartz, time
def click(x, y):
    ev = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, (x, y), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
    time.sleep(0.05)
    ev2 = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, (x, y), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev2)
click(${x}, ${y})
`);
      return 'clicked';
    }

    // ── 더블 클릭 ──
    case 'double_click': {
      const [x, y] = coordinate!;
      await runPython(`
import Quartz, time
def click(x, y):
    ev = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, (x, y), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
    time.sleep(0.05)
    ev2 = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, (x, y), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev2)
click(${x}, ${y})
time.sleep(0.05)
click(${x}, ${y})
`);
      return 'double clicked';
    }

    // ── 오른쪽 클릭 ──
    case 'right_click': {
      const [x, y] = coordinate!;
      await runPython(`
import Quartz, time
ev = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventRightMouseDown, (${x}, ${y}), Quartz.kCGMouseButtonRight)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
time.sleep(0.05)
ev2 = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventRightMouseUp, (${x}, ${y}), Quartz.kCGMouseButtonRight)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev2)
`);
      return 'right clicked';
    }

    // ── 가운데 클릭 ──
    case 'middle_click': {
      const [x, y] = coordinate!;
      await runPython(`
import Quartz, time
ev = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventOtherMouseDown, (${x}, ${y}), Quartz.kCGMouseButtonCenter)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
time.sleep(0.05)
ev2 = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventOtherMouseUp, (${x}, ${y}), Quartz.kCGMouseButtonCenter)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev2)
`);
      return 'middle clicked';
    }

    // ── 드래그 ──
    case 'left_click_drag': {
      const [sx, sy] = input.start_coordinate ?? coordinate!;
      const [ex, ey] = coordinate!;
      await runPython(`
import Quartz, time
ev = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, (${sx}, ${sy}), Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
time.sleep(0.1)
ev2 = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDragged, (${ex}, ${ey}), Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev2)
time.sleep(0.1)
ev3 = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, (${ex}, ${ey}), Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev3)
`);
      return 'dragged';
    }

    // ── 스크롤 ──
    case 'scroll': {
      const [x, y] = coordinate!;
      const dir = scroll_direction ?? 'down';
      const dist = scroll_distance ?? 3;
      // 수직: axis=1, 수평: axis=2
      const isHorizontal = dir === 'left' || dir === 'right';
      const delta = (dir === 'up' || dir === 'left') ? dist : -dist;
      const axes = isHorizontal ? `2, 0, ${delta}` : `1, ${delta}`;
      await runPython(`
import Quartz
ev = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, ${isHorizontal ? 2 : 1}, ${delta})
Quartz.CGEventSetLocation(ev, (${x}, ${y}))
Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
`);
      return 'scrolled';
    }

    // ── 텍스트 입력 (클립보드 경유 — Unicode 안전) ──
    case 'type': {
      if (!text) throw new Error('text required for type action');
      const tmp = path.join(os.tmpdir(), `cu_type_${Date.now()}.txt`);
      try {
        fs.writeFileSync(tmp, text, 'utf-8');
        await execAsync(`pbcopy < "${tmp}"`);
        await runOsascript(
          'tell application "System Events" to keystroke "v" using command down',
        );
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
      return 'typed';
    }

    // ── 키 입력 (Ctrl+C, Cmd+Z 등 수식키 조합 포함) ──
    case 'key': {
      if (!key) throw new Error('key required for key action');
      const parts = key.split('+');
      const mainKey = parts[parts.length - 1];
      const mods = parts.slice(0, -1)
        .map((m) => MODIFIER[m.toLowerCase()] ?? `${m} down`);
      const modStr = mods.length > 0 ? ` using {${mods.join(', ')}}` : '';

      const code = KEY_CODE[mainKey];
      const script = code !== undefined
        ? `tell application "System Events" to key code ${code}${modStr}`
        : `tell application "System Events" to keystroke "${mainKey}"${modStr}`;

      await runOsascript(script);
      return 'key pressed';
    }

    default:
      throw new Error(`Unknown computer action: ${action}`);
  }
}

// ── bash tool ──────────────────────────────────────────────

/**
 * bash 명령을 실행하고 stdout/stderr를 반환합니다.
 * timeout: 30초 (긴 명령은 백그라운드로 실행 권장)
 */
export async function executeBash(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30_000,
      shell: '/bin/bash',
    });
    const out = stdout.trim();
    const err = stderr.trim();
    if (out && err) return `${out}\nstderr: ${err}`;
    if (err) return `stderr: ${err}`;
    return out || '(출력 없음)';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = (e.stdout ?? '').trim();
    const errText = (e.stderr ?? e.message ?? '').trim();
    return out ? `${out}\n오류: ${errText}` : `오류: ${errText}`;
  }
}

// ── text_editor tool ───────────────────────────────────────

export interface TextEditorInput {
  command: 'view' | 'create' | 'str_replace' | 'insert' | 'undo_edit';
  path: string;
  file_text?: string;   // create 용
  old_str?: string;     // str_replace 용
  new_str?: string;     // str_replace / insert 용
  insert_line?: number; // insert 용
}

export function executeTextEditor(input: TextEditorInput): string {
  const { command, path: filePath } = input;

  switch (command) {
    case 'view': {
      if (!fs.existsSync(filePath)) return `파일 없음: ${filePath}`;
      const content = fs.readFileSync(filePath, 'utf-8');
      // 줄 번호 표시
      return content.split('\n')
        .map((l, i) => `${String(i + 1).padStart(6)} │ ${l}`)
        .join('\n');
    }

    case 'create': {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, input.file_text ?? '', 'utf-8');
      return `생성 완료: ${filePath}`;
    }

    case 'str_replace': {
      if (input.old_str === undefined) throw new Error('old_str required');
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.includes(input.old_str)) throw new Error('old_str를 파일에서 찾을 수 없습니다');
      fs.writeFileSync(filePath, content.replace(input.old_str, input.new_str ?? ''), 'utf-8');
      return '수정 완료';
    }

    case 'insert': {
      if (input.insert_line === undefined) throw new Error('insert_line required');
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.splice(input.insert_line, 0, input.new_str ?? '');
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
      return `${input.insert_line + 1}번째 줄에 삽입 완료`;
    }

    case 'undo_edit':
      return '실행 취소 미지원 (파일을 직접 수정하세요)';

    default:
      throw new Error(`Unknown text_editor command: ${command}`);
  }
}
