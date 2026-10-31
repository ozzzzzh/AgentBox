import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type {
  ContextInfo,
  HostToWebview,
  SettingsValues,
  WebviewToHost,
} from '../chat-protocol';
import {
  TurnTimeline,
  type TimelineKind,
  type TimelineSpan,
} from './timeline';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

function byId<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing element #${id}`);
  return element as unknown as T;
}

const transcript = byId<HTMLElement>('transcript');
const chatArea = byId<HTMLElement>('chat-area');
const questionNav = byId<HTMLElement>('question-nav');
const questionTooltip = byId<HTMLElement>('question-tooltip');
const input = byId<HTMLTextAreaElement>('input');
const submitButton = byId<HTMLButtonElement>('submit');
const sendIcon = byId<SVGElement>('icon-send');
const stopIcon = byId<SVGElement>('icon-stop');
const newButton = byId<HTMLButtonElement>('new');
const settingsButton = byId<HTMLButtonElement>('settings');
const openEditorButton = byId<HTMLButtonElement>('open-editor');
const sessionBar = byId<HTMLElement>('session-bar');
const statusLine = byId<HTMLElement>('status');
const contextBar = byId<HTMLElement>('context-bar');
const fileToggle = byId<HTMLButtonElement>('toggle-file');
const selectionToggle = byId<HTMLButtonElement>('toggle-selection');
const fileLabel = byId<HTMLElement>('file-label');
const selectionLabel = byId<HTMLElement>('selection-label');

const settingsPanel = byId<HTMLElement>('settings-panel');
const settingsScrim = byId<HTMLElement>('settings-scrim');
const settingsClose = byId<HTMLButtonElement>('settings-close');
const settingsCancel = byId<HTMLButtonElement>('settings-cancel');
const settingsSave = byId<HTMLButtonElement>('settings-save');
const settingRuntime = byId<HTMLSelectElement>('setting-runtime');
const settingTaskProfile = byId<HTMLSelectElement>('setting-task-profile');
const settingProvider = byId<HTMLInputElement>('setting-provider');
const settingModel = byId<HTMLInputElement>('setting-model');
const settingBaseUrl = byId<HTMLInputElement>('setting-base-url');
const settingApproval = byId<HTMLSelectElement>('setting-approval');
const settingsError = byId<HTMLElement>('settings-error');

const timelineEl = byId<HTMLElement>('timeline');
const timelineSummary = byId<HTMLElement>('timeline-summary');
const timelineTokens = byId<HTMLElement>('timeline-tokens');
const timelineElapsed = byId<HTMLElement>('timeline-elapsed');
const timelineToggle = byId<HTMLButtonElement>('timeline-toggle');
const timelineTooltip = byId<HTMLElement>('timeline-tooltip');
const timelineLanes: Record<TimelineKind, HTMLElement> = {
  thinking: byId<HTMLElement>('lane-thinking'),
  generation: byId<HTMLElement>('lane-generation'),
  tool: byId<HTMLElement>('lane-tool'),
};
let timeline = new TurnTimeline();

interface QuestionEntry {
  message: HTMLElement;
  preview: string;
}

let activeSessionId: string | null = null;
let sessionSummaries: Array<{ id: string; title: string; busy: boolean }> = [];
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let holdButton: HTMLButtonElement | null = null;

const questions: QuestionEntry[] = [];
let navWindowStart = -1;
let navWindowEnd = -1;
let navFrame: number | null = null;

const MAX_RESULT_CHARS = 4_000;
const MAX_ARGS_CHARS = 4_000;
const MAX_DIFF_CHARS = 6_000;

let busy = false;
let currentContextFile: string | undefined;
let currentSelectionKey: string | undefined;
let turnTokens: number | null = null;
let sessionTokens = 0;
let timelineTimer: ReturnType<typeof setInterval> | null = null;
let timelineHovering = false;
let timelineCollapsed = (() => {
  try {
    const state = vscode.getState() as
      | { timelineCollapsed?: boolean }
      | undefined;
    return state?.timelineCollapsed === true;
  } catch {
    return false;
  }
})();
let currentAssistant: HTMLElement | null = null;
let currentBody: HTMLElement | null = null;
let currentText = '';
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let thinking: HTMLElement | null = null;
let thinkingLabel: HTMLElement | null = null;
let thinkingMode = '思考中…';
let thinkingSince = 0;
let thinkingTimer: ReturnType<typeof setInterval> | null = null;
const toolCards = new Map<
  string,
  { card: HTMLElement; status: HTMLElement; body: HTMLElement; name: string }
>();
const approvalCards = new Map<
  string,
  {
    card: HTMLElement;
    status: HTMLElement;
    allow: HTMLButtonElement;
    deny: HTMLButtonElement;
  }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function post(message: WebviewToHost): void {
  vscode.postMessage(message);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizeOutput(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max)}…`;
}

function toolTitle(name: string): string {
  return name === 'fileChange' ? '修改文件' : name;
}

const COMMAND_TOOLS = new Set([
  'commandExecution',
  'run_shell',
  'shell',
  'shellCommand',
]);

function isCommandTool(name: string): boolean {
  return COMMAND_TOOLS.has(name);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to execCommand for older webview runtimes.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function enhanceCodeBlocks(container: HTMLElement): void {
  for (const pre of Array.from(container.querySelectorAll('pre'))) {
    if (pre.parentElement?.classList.contains('code-block')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = '复制';
    button.setAttribute('aria-label', '复制代码');
    button.addEventListener('click', () => {
      const code =
        pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      void copyText(code).then((ok) => {
        button.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => {
          button.textContent = '复制';
        }, 1_200);
      });
    });
    wrapper.appendChild(button);
  }
}

function formatTimelineDuration(ms: number): string {
  const value = Math.max(ms, 0);
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function toolSpanSummary(name: string, args: unknown): string {
  if (
    isCommandTool(name) &&
    isRecord(args) &&
    typeof args.command === 'string'
  ) {
    return truncate(args.command, 140);
  }
  if (
    name === 'fileChange' &&
    isRecord(args) &&
    Array.isArray(args.changes)
  ) {
    const paths = args.changes
      .map((change) =>
        isRecord(change) && typeof change.path === 'string'
          ? change.path
          : ''
      )
      .filter((path) => path !== '');
    if (paths.length > 0) return truncate(paths.join(', '), 140);
  }
  try {
    return truncate(JSON.stringify(args) ?? String(args), 140);
  } catch {
    return truncate(String(args), 140);
  }
}

function describeTimelineSpan(span: TimelineSpan): string {
  const duration = formatTimelineDuration(span.end - span.start);
  if (span.kind === 'thinking') return `思考 · ${duration}`;
  if (span.kind === 'generation') return `生成 · ${duration}`;
  const status = span.ok === false ? '工具失败' : '工具';
  const summary = span.summary !== undefined ? `\n${span.summary}` : '';
  return `${status} · ${span.label} · ${duration}${summary}`;
}

function positionTimelineTooltip(event: MouseEvent): void {
  if (timelineTooltip.hidden) return;
  const rect = timelineEl.getBoundingClientRect();
  const half = Math.min(timelineTooltip.offsetWidth / 2, rect.width / 2);
  const minX = half + 4;
  const maxX = Math.max(rect.width - half - 4, minX);
  const x = Math.min(Math.max(event.clientX - rect.left, minX), maxX);
  timelineTooltip.style.left = `${x}px`;
  timelineTooltip.style.top = `${event.clientY - rect.top - 8}px`;
}

function showTimelineTooltip(span: TimelineSpan, event: MouseEvent): void {
  timelineHovering = true;
  timelineTooltip.textContent = describeTimelineSpan(span);
  timelineTooltip.hidden = false;
  positionTimelineTooltip(event);
}

function hideTimelineTooltip(): void {
  timelineHovering = false;
  timelineTooltip.hidden = true;
}

function focusToolCard(callId: string): void {
  const entry = toolCards.get(callId);
  if (entry === undefined) {
    // commandExecution has no card in the chat; its details live in the log.
    post({ type: 'showLog' });
    return;
  }
  entry.card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  entry.card.classList.add('timeline-flash');
  setTimeout(() => {
    entry.card.classList.remove('timeline-flash');
  }, 1_200);
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function renderTokenUsage(): void {
  if (turnTokens === null && sessionTokens === 0) {
    timelineTokens.hidden = true;
    return;
  }
  timelineTokens.hidden = false;
  const current = turnTokens === null ? '—' : formatTokens(turnTokens);
  timelineTokens.textContent = `${current} / ${formatTokens(
    sessionTokens
  )} tok`;
  timelineTokens.title =
    `本轮 ${turnTokens ?? '未知'} tokens · ` +
    `会话总计 ${sessionTokens} tokens`;
}

interface SummaryCount {
  kind: TimelineKind | 'fail';
  label: string;
  count: number;
}

function renderTimelineSummary(items: SummaryCount[]): void {
  timelineSummary.replaceChildren();
  for (const item of items) {
    if (item.count <= 0) continue;
    const chip = document.createElement('span');
    chip.className = `timeline-count kind-${item.kind}`;
    chip.title = `${item.label} ${item.count}`;
    chip.setAttribute('aria-label', `${item.label} ${item.count}`);
    const swatch = document.createElement('i');
    const number = document.createElement('span');
    number.textContent = String(item.count);
    chip.append(swatch, number);
    timelineSummary.appendChild(chip);
  }
}

function renderTimeline(): void {
  const now = Date.now();
  const spans = timeline.snapshot(now);
  for (const lane of Object.values(timelineLanes)) {
    lane.replaceChildren();
  }

  if (!timeline.started) {
    timelineSummary.replaceChildren();
    timelineElapsed.textContent = '等待任务…';
    hideTimelineTooltip();
    return;
  }

  const start = timeline.start;
  const total = Math.max(timeline.duration(now), 1);
  let thinking = 0;
  let generation = 0;
  let tools = 0;
  let failed = 0;

  for (const span of spans) {
    if (span.kind === 'thinking') thinking += 1;
    if (span.kind === 'generation') generation += 1;
    if (span.kind === 'tool') {
      tools += 1;
      if (span.ok === false) failed += 1;
    }
  }

  renderTimelineSummary([
    { kind: 'thinking', label: '思考', count: thinking },
    { kind: 'generation', label: '生成', count: generation },
    { kind: 'tool', label: '工具', count: tools },
    { kind: 'fail', label: '失败', count: failed },
  ]);
  timelineElapsed.textContent = `${formatTimelineDuration(
    timeline.duration(now)
  )}${timeline.running ? ' · 进行中' : ''}`;

  if (timelineCollapsed) {
    hideTimelineTooltip();
    return;
  }

  for (const span of spans) {
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = `timeline-bar kind-${span.kind}${
      span.ok === false ? ' fail' : ''
    }`;
    const left = Math.min(
      Math.max(((span.start - start) / total) * 100, 0),
      100
    );
    const width = Math.min(
      Math.max(((span.end - span.start) / total) * 100, 0.2),
      100 - left
    );
    bar.style.left = `${left}%`;
    bar.style.width = `${Math.max(width, 0.2)}%`;
    bar.setAttribute('aria-label', describeTimelineSpan(span));
    bar.addEventListener('mouseenter', (event) => {
      showTimelineTooltip(span, event);
    });
    bar.addEventListener('mousemove', positionTimelineTooltip);
    bar.addEventListener('mouseleave', hideTimelineTooltip);
    if (span.kind === 'tool' && span.callId !== undefined) {
      const callId = span.callId;
      bar.addEventListener('click', () => focusToolCard(callId));
    }
    timelineLanes[span.kind].appendChild(bar);
  }
}

function applyTimelineCollapsed(): void {
  timelineEl.classList.toggle('collapsed', timelineCollapsed);
  timelineToggle.textContent = timelineCollapsed ? '▸' : '▾';
  const label = timelineCollapsed ? '展开活动时间线' : '收起活动时间线';
  timelineToggle.title = label;
  timelineToggle.setAttribute('aria-label', label);
  timelineToggle.setAttribute('aria-expanded', String(!timelineCollapsed));
  if (timelineCollapsed) hideTimelineTooltip();
}

function toggleTimeline(): void {
  timelineCollapsed = !timelineCollapsed;
  applyTimelineCollapsed();
  try {
    vscode.setState({ timelineCollapsed });
  } catch {
    // State persistence is best effort.
  }
  renderTimeline();
}

function startTimelineClock(): void {
  if (timelineTimer !== null) return;
  timelineTimer = setInterval(() => {
    if (!timelineHovering) renderTimeline();
  }, 250);
}

function stopTimelineClock(): void {
  if (timelineTimer !== null) {
    clearInterval(timelineTimer);
    timelineTimer = null;
  }
}

function renderMarkdown(text: string): string {
  const html = marked.parse(normalizeOutput(text), {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    FORBID_TAGS: [
      'style',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'link',
      'meta',
      'base',
      'img',
    ],
    FORBID_ATTR: ['style', 'srcset', 'formaction'],
  });
}

function isNearBottom(): boolean {
  return (
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
    80
  );
}

function scrollToBottom(): void {
  transcript.scrollTop = transcript.scrollHeight;
}

function appendElement(element: HTMLElement): void {
  (currentAssistant ?? transcript).appendChild(element);
  keepThinkingAtBottom();
  if (isNearBottom()) scrollToBottom();
}

function keepThinkingAtBottom(): void {
  if (thinking !== null && currentAssistant !== null) {
    currentAssistant.appendChild(thinking);
  }
}

function renderThinkingLabel(): void {
  if (thinkingLabel === null) return;
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - thinkingSince) / 1_000)
  );
  thinkingLabel.textContent =
    seconds > 0 ? `${thinkingMode} ${seconds}s` : thinkingMode;
}

function setThinkingLabel(text: string): void {
  thinkingMode = text;
  thinkingSince = Date.now();
  renderThinkingLabel();
}

function showThinking(label = '思考中…'): void {
  ensureAssistant();
  if (thinking === null) {
    thinking = document.createElement('div');
    thinking.className = 'thinking';
    const dots = document.createElement('span');
    dots.className = 'thinking-dots';
    for (let index = 0; index < 3; index += 1) {
      dots.appendChild(document.createElement('i'));
    }
    thinkingLabel = document.createElement('span');
    thinking.append(dots, thinkingLabel);
  }
  setThinkingLabel(label);
  if (thinkingTimer === null) {
    thinkingTimer = setInterval(renderThinkingLabel, 1_000);
  }
  currentAssistant?.appendChild(thinking);
  if (isNearBottom()) scrollToBottom();
}

function removeThinking(): void {
  if (thinkingTimer !== null) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
  thinking?.remove();
  thinking = null;
  thinkingLabel = null;
}

function ensureAssistant(): HTMLElement {
  if (currentBody === null) {
    removeThinking();
    currentAssistant = document.createElement('div');
    currentAssistant.className = 'message assistant';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const mark = document.createElement('span');
    mark.className = 'brand-mark';
    mark.textContent = '⌘';
    const name = document.createElement('span');
    name.textContent = 'AgentBox';
    meta.append(mark, name);
    currentBody = document.createElement('div');
    currentBody.className = 'message-body markdown';
    currentAssistant.append(meta, currentBody);
    transcript.appendChild(currentAssistant);
    currentText = '';
  }
  return currentBody;
}

function scheduleRender(): void {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (currentBody === null) return;
    const stick = isNearBottom();
    currentBody.innerHTML = renderMarkdown(currentText);
    enhanceCodeBlocks(currentBody);
    if (stick) scrollToBottom();
  }, 50);
}

function addUserMessage(text: string): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'message user';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = '你';
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = text;
  wrapper.append(meta, body);
  transcript.appendChild(wrapper);

  questions.push({ message: wrapper, preview: truncate(text, 20) });
  scrollToBottom();
  renderQuestionNav(true);
}

function createQuestionMarker(
  entry: QuestionEntry,
  index: number
): HTMLButtonElement {
  const marker = document.createElement('button');
  marker.type = 'button';
  marker.className = 'question-marker';
  marker.dataset.preview = entry.preview;
  marker.setAttribute(
    'aria-label',
    `跳到问题 ${index + 1}：${entry.preview}`
  );
  marker.addEventListener('mouseenter', () => {
    questionTooltip.textContent = entry.preview;
    questionTooltip.hidden = false;
    const areaRect = chatArea.getBoundingClientRect();
    const rect = marker.getBoundingClientRect();
    questionTooltip.style.top = `${
      rect.top - areaRect.top + rect.height / 2
    }px`;
    questionTooltip.style.right = `${
      areaRect.right - rect.left + 8
    }px`;
  });
  marker.addEventListener('mouseleave', () => {
    questionTooltip.hidden = true;
  });
  marker.addEventListener('click', () => {
    entry.message.scrollIntoView({
      block: 'start',
      behavior: 'smooth',
    });
    entry.message.classList.add('message-flash');
    setTimeout(() => {
      entry.message.classList.remove('message-flash');
    }, 1_200);
  });
  return marker;
}

/**
 * Keep at most 10 markers around the current viewport so long conversations
 * do not grow the rail indefinitely. The window slides while scrolling.
 */
function renderQuestionNav(force = false): void {
  if (questions.length === 0) {
    questionNav.replaceChildren();
    questionNav.hidden = true;
    questionTooltip.hidden = true;
    navWindowStart = -1;
    navWindowEnd = -1;
    return;
  }

  questionNav.hidden = false;
  const viewCenter =
    transcript.scrollTop + transcript.clientHeight / 2;
  let nearest = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < questions.length; index += 1) {
    const message = questions[index]?.message;
    if (message === undefined) continue;
    const center = message.offsetTop + message.offsetHeight / 2;
    const distance = Math.abs(center - viewCenter);
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = index;
    }
  }

  const maxMarkers = 10;
  let start = Math.max(0, nearest - Math.floor(maxMarkers / 2));
  let end = Math.min(questions.length, start + maxMarkers);
  start = Math.max(0, end - maxMarkers);

  if (!force && start === navWindowStart && end === navWindowEnd) {
    return;
  }
  navWindowStart = start;
  navWindowEnd = end;

  questionNav.replaceChildren();
  questionTooltip.hidden = true;
  for (let index = start; index < end; index += 1) {
    const entry = questions[index];
    if (entry === undefined) continue;
    questionNav.appendChild(createQuestionMarker(entry, index));
  }
}

function scheduleQuestionNav(): void {
  if (navFrame !== null) return;
  navFrame = requestAnimationFrame(() => {
    navFrame = null;
    renderQuestionNav();
  });
}

function addPre(
  parent: HTMLElement,
  text: string,
  className: string
): HTMLPreElement {
  const pre = document.createElement('pre');
  pre.className = className;
  pre.textContent = text;
  parent.appendChild(pre);
  return pre;
}

function setExpandable(
  pre: HTMLPreElement,
  fullText: string,
  maxChars: number
): void {
  if (fullText.length <= maxChars) {
    pre.textContent = fullText;
    return;
  }

  pre.textContent = `${fullText.slice(0, maxChars)}\n…（共 ${fullText.length} 字符）`;
  const button = document.createElement('button');
  button.className = 'link-button';
  button.textContent = '显示完整内容';
  button.addEventListener('click', () => {
    pre.textContent = fullText;
    button.remove();
  });
  pre.insertAdjacentElement('afterend', button);
}

function pretty(value: unknown, maxChars = MAX_ARGS_CHARS): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n…（共 ${text.length} 字符）`;
}

function addFileChip(parent: HTMLElement, path: string): void {
  const button = document.createElement('button');
  button.className = 'file-chip';
  button.textContent = `📄 ${path}`;
  button.title = `打开 ${path}`;
  button.addEventListener('click', () => {
    post({ type: 'openFile', path });
  });
  parent.appendChild(button);
}

function renderToolArgs(
  body: HTMLElement,
  name: string,
  args: unknown
): void {
  if (
    name === 'fileChange' &&
    isRecord(args) &&
    Array.isArray(args.changes)
  ) {
    for (const change of args.changes) {
      if (!isRecord(change) || typeof change.path !== 'string') continue;
      addFileChip(body, change.path);
      const diff = typeof change.diff === 'string' ? change.diff : '';
      if (diff !== '') {
        const pre = addPre(body, '', 'tool-diff');
        setExpandable(pre, normalizeOutput(diff), MAX_DIFF_CHARS);
      }
    }
    return;
  }

  const pre = addPre(body, '', 'tool-args');
  setExpandable(pre, pretty(args), MAX_ARGS_CHARS);
}

function createToolCard(
  callId: string,
  name: string,
  args: unknown
): {
  card: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
  name: string;
} {
  const card = document.createElement('div');
  card.className = 'tool-card';

  const header = document.createElement('div');
  header.className = 'tool-header';
  const title = document.createElement('span');
  title.className = 'tool-name';
  title.textContent = `🔧 ${toolTitle(name)}`;
  const status = document.createElement('span');
  status.className = 'tool-status running';
  status.textContent = '运行中';
  header.append(title, status);

  const body = document.createElement('div');
  body.className = 'tool-body';
  renderToolArgs(body, name, args);

  card.append(header, body);
  appendElement(card);
  setThinkingLabel('执行工具…');

  const entry = { card, status, body, name };
  toolCards.set(callId, entry);
  return entry;
}

function settleApprovalCard(
  id: string,
  text: string,
  kind: 'allow' | 'deny'
): void {
  const entry = approvalCards.get(id);
  if (entry === undefined) return;
  entry.card.dataset.done = '1';
  entry.allow.disabled = true;
  entry.deny.disabled = true;
  entry.status.textContent = text;
  entry.status.className = `approval-status ${kind}`;
}

function createApprovalCard(message: Extract<HostToWebview, { type: 'approval.request' }>): void {
  const card = document.createElement('div');
  card.className = 'approval-card';

  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = `需要审批：${message.name}`;

  const body = document.createElement('div');
  body.className = 'approval-body';
  const pre = addPre(body, '', 'tool-args');
  setExpandable(pre, pretty(message.args), MAX_ARGS_CHARS);
  if (message.warning !== undefined) {
    const warning = document.createElement('div');
    warning.className = 'approval-warning';
    warning.textContent = message.warning;
    body.appendChild(warning);
  }

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const allow = document.createElement('button');
  allow.className = 'primary';
  allow.textContent = '允许';
  const deny = document.createElement('button');
  deny.className = 'secondary';
  deny.textContent = '拒绝';
  const status = document.createElement('span');
  status.className = 'approval-status';
  status.textContent = '等待中';
  actions.append(allow, deny, status);

  const decide = (decision: 'allow' | 'deny'): void => {
    if (card.dataset.done === '1') return;
    card.dataset.done = '1';
    allow.disabled = true;
    deny.disabled = true;
    status.textContent = decision === 'allow' ? '已允许' : '已拒绝';
    status.className = `approval-status ${decision}`;
    post({ type: 'approval.response', id: message.id, decision });
  };

  allow.addEventListener('click', () => decide('allow'));
  deny.addEventListener('click', () => decide('deny'));

  card.append(title, body, actions);
  appendElement(card);
  approvalCards.set(message.id, { card, status, allow, deny });
}

function addLog(text: string): void {
  if (text.startsWith('▶ ')) return; // the webview already renders the user prompt
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = text;
  appendElement(line);
}

function addError(code: string | undefined, message: string): void {
  const card = document.createElement('div');
  card.className = 'error-card';
  const title = document.createElement('div');
  title.className = 'error-title';
  title.textContent = code !== undefined ? `错误 · ${code}` : '错误';
  const body = document.createElement('div');
  body.textContent = normalizeOutput(message);
  card.append(title, body);
  appendElement(card);
}

function setBusy(next: boolean): void {
  busy = next;
  submitButton.classList.toggle('stop', next);
  submitButton.title = next ? '停止' : '发送';
  submitButton.setAttribute(
    'aria-label',
    next ? '停止当前运行' : '发送'
  );
  sendIcon.toggleAttribute('hidden', next);
  stopIcon.toggleAttribute('hidden', !next);
  newButton.disabled = next;
  statusLine.classList.toggle('busy', next);
  statusLine.textContent = next ? '运行中…' : '空闲';
  if (!next) {
    if (timeline.running) {
      timeline.finish(Date.now());
      renderTimeline();
    }
    stopTimelineClock();
    removeThinking();
    input.focus();
  }
}

function isPressed(button: HTMLButtonElement): boolean {
  return button.getAttribute('aria-pressed') === 'true';
}

function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}

function updateContext(next: ContextInfo): void {
  const file = next.file;
  const selection = next.selection;
  const fileChanged = file !== currentContextFile;
  const selectionKey =
    selection === undefined
      ? undefined
      : `${file ?? ''}:${selection.startLine}:${selection.endLine}`;
  const selectionChanged = selectionKey !== currentSelectionKey;
  currentContextFile = file;
  currentSelectionKey = selectionKey;

  fileToggle.hidden = file === undefined;
  fileToggle.disabled = file === undefined;
  fileToggle.title =
    file === undefined ? '当前没有可用的文件' : `加入当前文件：${file}`;
  fileLabel.textContent = file ?? '当前文件';
  if (file === undefined) {
    setPressed(fileToggle, false);
  } else if (fileChanged) {
    // Opening/switching a file enables it as context by default.
    setPressed(fileToggle, true);
  }

  selectionToggle.hidden = selection === undefined;
  selectionToggle.disabled = selection === undefined;
  if (selection === undefined) {
    setPressed(selectionToggle, false);
    selectionLabel.textContent = '选区';
    selectionLabel.title = '';
    selectionToggle.title = '当前没有选区';
  } else {
    selectionLabel.textContent = `选区 L${selection.startLine}-${selection.endLine}`;
    selectionLabel.title = selection.preview;
    selectionToggle.title = '加入当前选区';
    if (selectionChanged) {
      // A new selection is enabled by default; the same selection keeps the
      // user's manual on/off choice.
      setPressed(selectionToggle, true);
    }
  }

  contextBar.hidden = file === undefined && selection === undefined;
}

function resetActiveView(): void {
  timeline = new TurnTimeline();
  stopTimelineClock();
  clearTranscript();
  turnTokens = null;
  sessionTokens = 0;
  navWindowStart = -1;
  navWindowEnd = -1;
  renderTimeline();
  renderTokenUsage();
}

function cancelHold(): void {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  holdButton?.classList.remove('holding');
  holdButton = null;
}

function beginHold(button: HTMLButtonElement, id: string): void {
  cancelHold();
  holdButton = button;
  button.classList.add('holding');
  holdTimer = setTimeout(() => {
    const target = holdButton;
    cancelHold();
    target?.classList.remove('holding');
    post({ type: 'session.close', id, confirm: true });
  }, 650);
}

function renderSessionTabs(): void {
  cancelHold();
  sessionBar.replaceChildren();
  for (const summary of sessionSummaries) {
    const wrap = document.createElement('div');
    wrap.className = `session-tab-wrap${
      summary.id === activeSessionId ? ' active' : ''
    }`;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'session-tab';
    tab.textContent = summary.title;
    tab.title = summary.title;
    tab.setAttribute('role', 'tab');
    tab.setAttribute(
      'aria-selected',
      summary.id === activeSessionId ? 'true' : 'false'
    );
    tab.addEventListener('click', () => {
      if (summary.id !== activeSessionId) {
        post({ type: 'session.select', id: summary.id });
      }
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'session-close';
    close.textContent = '×';
    close.title = '长按关闭会话';
    close.setAttribute('aria-label', `长按关闭会话 ${summary.title}`);
    close.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      beginHold(close, summary.id);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      close.addEventListener(type, cancelHold);
    }
    close.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      post({ type: 'session.close', id: summary.id, confirm: true });
    });
    close.addEventListener('click', (event) => {
      // Pointer holds are handled above; suppress the click that follows a
      // pointer sequence so a short click never closes a session.
      event.stopPropagation();
    });

    wrap.append(tab, close);
    sessionBar.appendChild(wrap);
  }
}

function applySessions(
  summaries: Array<{ id: string; title: string; busy: boolean }>,
  activeId: string
): void {
  sessionSummaries = summaries;
  if (activeSessionId === null && activeId !== '') {
    activeSessionId = activeId;
  }
  renderSessionTabs();
}

function clearTranscript(): void {
  transcript.replaceChildren();
  questions.length = 0;
  navWindowStart = -1;
  navWindowEnd = -1;
  if (navFrame !== null) {
    cancelAnimationFrame(navFrame);
    navFrame = null;
  }
  questionNav.replaceChildren();
  questionNav.hidden = true;
  questionTooltip.hidden = true;
  removeThinking();
  currentAssistant = null;
  currentBody = null;
  currentText = '';
  toolCards.clear();
  approvalCards.clear();
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
}

function handleMessage(message: HostToWebview): void {
  switch (message.type) {
    case 'state':
      if (message.busy) {
        showThinking();
      }
      setBusy(message.busy);
      return;

    case 'sessions':
      applySessions(message.sessions, message.activeId);
      return;

    case 'session.load':
      activeSessionId = message.id;
      cancelHold();
      resetActiveView();
      for (const event of message.events) {
        handleMessage(event);
      }
      renderSessionTabs();
      return;

    case 'context':
      updateContext(message.context);
      return;

    case 'settings':
      applySettings(message.values);
      return;

    case 'settings.open':
      openSettingsPanel();
      return;

    case 'settings.saved':
      closeSettingsPanel();
      return;

    case 'settings.error':
      showSettingsError(message.message);
      return;

    case 'user.message':
      addUserMessage(message.text);
      return;

    case 'busy':
      setBusy(message.busy);
      return;

    case 'turn.start':
      turnTokens = null;
      renderTokenUsage();
      timeline.begin(Date.now());
      startTimelineClock();
      renderTimeline();
      ensureAssistant();
      showThinking();
      setBusy(true);
      return;

    case 'assistant.delta':
      if (timeline.textDelta(Date.now())) {
        renderTimeline();
      }
      ensureAssistant();
      currentText += message.text;
      setThinkingLabel('生成中…');
      scheduleRender();
      return;

    case 'tool.start':
      timeline.toolStart(
        Date.now(),
        message.callId,
        message.name,
        toolSpanSummary(message.name, message.args)
      );
      renderTimeline();
      if (isCommandTool(message.name)) {
        // Commands live only in the timeline + AgentBox Chat log, not in the
        // transcript, so they do not consume conversation space.
        setThinkingLabel('执行工具…');
      } else {
        createToolCard(message.callId, message.name, message.args);
      }
      return;

    case 'tool.end': {
      timeline.toolEnd(Date.now(), message.callId, message.ok);
      renderTimeline();
      setThinkingLabel(currentText === '' ? '思考中…' : '生成中…');
      if (isCommandTool(message.name)) return;
      const entry =
        toolCards.get(message.callId) ??
        createToolCard(message.callId, message.name, {});
      entry.status.textContent = message.ok ? '完成' : '失败';
      entry.status.className = `tool-status ${message.ok ? 'ok' : 'fail'}`;
      const result = normalizeOutput(message.result);
      if (result.trim() !== '') {
        const pre = addPre(entry.body, '', 'tool-result');
        setExpandable(pre, result, MAX_RESULT_CHARS);
      }
      return;
    }

    case 'file.changed':
      addFileChip(
        currentAssistant ?? transcript,
        message.path
      );
      return;

    case 'token.usage':
      turnTokens = message.turn;
      sessionTokens = message.session;
      renderTokenUsage();
      return;

    case 'approval.request':
      timeline.approvalWait(Date.now());
      renderTimeline();
      setThinkingLabel('等待审批…');
      createApprovalCard(message);
      return;

    case 'approval.resolved':
      settleApprovalCard(
        message.id,
        message.decision === 'allow' ? '已允许' : '已拒绝',
        message.decision
      );
      setThinkingLabel(currentText === '' ? '思考中…' : '生成中…');
      return;

    case 'approval.cancelled':
      settleApprovalCard(message.id, '已失效', 'deny');
      setThinkingLabel(currentText === '' ? '思考中…' : '生成中…');
      return;

    case 'turn.end':
      timeline.finish(Date.now());
      stopTimelineClock();
      renderTimeline();
      removeThinking();
      if (currentBody !== null) {
        currentBody.innerHTML = renderMarkdown(currentText);
        enhanceCodeBlocks(currentBody);
      }
      currentAssistant = null;
      currentBody = null;
      currentText = '';
      for (const [id, entry] of approvalCards) {
        if (entry.card.dataset.done !== '1') {
          settleApprovalCard(id, '已失效', 'deny');
        }
      }
      setBusy(false);
      return;

    case 'error':
      addError(message.code, message.message);
      return;

    case 'log':
      addLog(message.text);
      return;

    case 'clear':
      activeSessionId = null;
      sessionSummaries = [];
      cancelHold();
      renderSessionTabs();
      resetActiveView();
      return;
  }
}

function autoResize(): void {
  input.style.height = 'auto';
  const maxHeight = 220;
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  input.style.overflowY =
    input.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function showSettingsError(message: string): void {
  settingsError.textContent = message;
  settingsError.hidden = false;
}

function clearSettingsError(): void {
  settingsError.textContent = '';
  settingsError.hidden = true;
}

function openSettingsPanel(): void {
  clearSettingsError();
  settingsPanel.hidden = false;
  settingsScrim.hidden = false;
  post({ type: 'settings.request' });
  settingRuntime.focus();
}

function closeSettingsPanel(): void {
  settingsPanel.hidden = true;
  settingsScrim.hidden = true;
  input.focus();
}

function applySettings(values: SettingsValues): void {
  settingRuntime.value = values.runtime;
  settingTaskProfile.value = values.taskProfile;
  settingProvider.value = values.provider;
  settingModel.value = values.model;
  settingBaseUrl.value = values.baseUrl;
  settingApproval.value = values.approvalPolicy;
}

function saveSettings(): void {
  const values: SettingsValues = {
    runtime: settingRuntime.value,
    taskProfile: settingTaskProfile.value,
    provider: settingProvider.value.trim(),
    model: settingModel.value.trim(),
    baseUrl: settingBaseUrl.value.trim(),
    approvalPolicy: settingApproval.value,
  };
  clearSettingsError();
  post({ type: 'settings.save', values });
}

function sendPrompt(): void {
  if (busy) return;
  const text = input.value.trim();
  if (text === '') return;

  input.value = '';
  autoResize();
  setBusy(true);
  post({
    type: 'prompt',
    text,
    includeFile: isPressed(fileToggle),
    includeSelection: isPressed(selectionToggle),
  });
}

submitButton.addEventListener('click', () => {
  if (busy) {
    post({ type: 'cancel' });
  } else {
    sendPrompt();
  }
});
newButton.addEventListener('click', () => {
  if (busy) return;
  post({ type: 'session.new' });
});
openEditorButton.addEventListener('click', () => {
  post({ type: 'openEditor' });
});
settingsButton.addEventListener('click', openSettingsPanel);
settingsClose.addEventListener('click', closeSettingsPanel);
settingsCancel.addEventListener('click', closeSettingsPanel);
settingsSave.addEventListener('click', saveSettings);
settingsScrim.addEventListener('click', closeSettingsPanel);
timelineEl.addEventListener('mouseleave', hideTimelineTooltip);
timelineToggle.addEventListener('click', toggleTimeline);
transcript.addEventListener('scroll', scheduleQuestionNav);
window.addEventListener('resize', scheduleQuestionNav);

fileToggle.addEventListener('click', () => {
  setPressed(fileToggle, !isPressed(fileToggle));
});
selectionToggle.addEventListener('click', () => {
  setPressed(selectionToggle, !isPressed(selectionToggle));
});

input.addEventListener('input', autoResize);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsPanel.hidden) {
    closeSettingsPanel();
  }
});

transcript.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest('a');
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute('href');
  if (href === null || !/^https?:\/\//i.test(href)) return;
  // Keep the webview on its own page; let VS Code open the browser.
  event.preventDefault();
  post({ type: 'openExternal', url: href });
});

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  handleMessage(event.data);
});

applyTimelineCollapsed();
setBusy(false);
autoResize();
renderSessionTabs();
renderTimeline();
renderTokenUsage();
post({ type: 'ready' });
input.focus();
