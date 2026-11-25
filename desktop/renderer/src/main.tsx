import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Code2,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  GitCompare,
  Layers,
  LoaderCircle,
  Menu,
  MessageSquare,
  Paperclip,
  Plus,
  Palette,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { FileEditorViewer, type OpenFile } from './files/FileEditorViewer.js';
import { computeLineDiff } from './files/line-diff.js';
import { groupConversationEvents, type SessionEvent } from './conversation/events.js';
import { EventCard, ToolActivity, MarkdownMessage } from './conversation/Messages.js';
import { date } from './formatting.js';
import { connectorTemplates } from './connectors.js';
import type { AttachmentRef } from '../../../src/core/attachments.js';
import type { PatchPreflight } from '../../../src/core/workspace-patch.js';
import { pendingQuestion } from '../../../src/core/question.js';
import {
  memoryReviewTurns,
  type MemoryReviewPreview,
  type MemoryReviewTurn,
} from '../../../src/core/memory-review.js';
import './style.css';
import { recordedUsage, recordedTokenLabel } from '../../../src/core/usage.js';
import { pendingInputs } from '../../../src/core/input-queue.js';
import { acceptsEventSnapshot } from '../../../src/core/event-snapshot.js';
import { canResumeTurn, turnState } from '../../../src/core/turn-state.js';
import { needsUnknownReview, unreviewedUnknownTools } from '../../../src/core/unknown-review.js';
import bearWhite from '../../assets/icon-white.png';
import bearBlack from '../../assets/icon-black.png';
import bearSage from '../../assets/icon-sage.png';
import bearBlue from '../../assets/icon-blue.png';
import bearOrange from '../../assets/icon-orange.png';

const iconOptions = [
  { id: 'white', label: '纯白', image: bearWhite },
  { id: 'black', label: '黑色', image: bearBlack },
  { id: 'sage', label: '鼠尾草绿', image: bearSage },
  { id: 'blue', label: '浅蓝', image: bearBlue },
  { id: 'orange', label: '暖橙', image: bearOrange },
] as const;

type Profile = {
  alias: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindowTokens?: number;
};
type Session = {
  id: string;
  workspace: string;
  managedWorkspace?: boolean;
  profile: Profile;
  createdAt: string;
  updatedAt: string;
};
type SessionView = {
  session: Session;
  events: SessionEvent[];
  plan: { enabled: boolean; steps: string[]; approved: boolean; progress: Record<number, string> };
  needsReview: boolean;
  recoveredUnknown?: number;
  tasks?: TaskNode[];
  state?: { phase: string; canResume: boolean; needsReview: boolean };
};
type ComposerDraft = {
  composer: string;
  attachments: AttachmentRef[];
  quote: { seq: number; text: string } | null;
};
const emptyDraft: ComposerDraft = { composer: '', attachments: [], quote: null };
type FileDecision = {
  paths: string[];
  resolve: (choice: 'save' | 'discard' | 'cancel') => void;
};
type CronJob = {
  id: string;
  expression: string;
  prompt: string;
  nextRunAt: number;
  lastStatus?: string;
  planSeq?: number;
};
type TaskNode = {
  id: string;
  title: string;
  description: string;
  status: string;
  dependencies: string[];
  blocks: string[];
};
type Skill = {
  name: string;
  description: string;
  source: string;
  revision: string;
  enabled: boolean;
  path: string;
};
type Market = { name: string; source: string };
type MarketEntry = { name: string; description: string; path: string };
type Approval = {
  sessionId: string;
  workspace?: string;
  approvalId: string;
  call: { name: string; input: Record<string, unknown> };
  reason: string;
};
type ApprovalScope = 'once' | 'session' | 'always';
type McpServer =
  | { name: string; transport: 'stdio'; command: string; args: string[]; envNames: string[] }
  | {
      name: string;
      transport: 'http';
      url: string;
      tokenEnv?: string;
      oauth?: { clientId?: string; callbackPort?: number };
    };
type Hook = {
  name: string;
  event: 'before_tool' | 'after_tool' | 'turn_started' | 'turn_finished';
  command: string;
  enabled: boolean;
};
type Config = {
  profiles: Profile[];
  defaultProfile?: string;
  marketplaces: Market[];
  mcpServers: McpServer[];
  hooks: Hook[];
  approvalMode: 'ask' | 'autoSafe' | 'auto';
  approvedCommands: { workspace: string; command: string; sessionId?: string }[];
  webhookUrl?: string;
};
type HostEvent = {
  type: string;
  sessionId?: string;
  workspace?: string;
  delta?: string;
  message?: string;
  events?: SessionEvent[];
  approvalId?: string;
  call?: Approval['call'];
  reason?: string;
};
type WorkspaceEntry = { name: string; path: string; kind: 'file' | 'directory' };
type UserPreference = { id: string; content: string; createdAt: string };

declare global {
  interface Window {
    bruin: {
      request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
      onEvent(callback: (message: HostEvent) => void): () => void;
    };
  }
}

const api = <T,>(method: string, params?: Record<string, unknown>) =>
  window.bruin.request<T>(method, params);
const short = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;
function sessionTitle(session: Session, events?: SessionEvent[]) {
  const user = events?.find((e) => e.type === 'user');
  const label = typeof user?.payload.text === 'string' ? user.payload.text : '';
  if (label) return label.slice(0, 36);
  if (session.managedWorkspace) return `新会话 (${short(session.workspace).slice(-8)})`;
  return short(session.workspace);
}
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function restoreLineEndings(text: string, eol?: '\r\n' | '\n'): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

const EditorTab = React.memo(function EditorTab({
  file,
  active,
  savingFile,
  onSelect,
  onClose,
}: {
  file: OpenFile;
  active: boolean;
  savingFile: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const isDirty = file.content !== file.originalContent;
  const diffBase = file.baselineContent ?? file.originalContent;
  const stat = useMemo(() => computeLineDiff(diffBase, file.content), [diffBase, file.content]);
  return (
    <div className={`editor-tab ${active ? 'active' : ''}`}>
      <button
        role="tab"
        aria-selected={active}
        title={file.path}
        onClick={() => onSelect(file.path)}
      >
        <FileCode size={14} />
        <span className="tab-title">{short(file.path)}</span>
        {(stat.additions > 0 || stat.deletions > 0) && (
          <span className="tab-diff-stats">
            {stat.additions > 0 && <span className="diff-add">+{stat.additions}</span>}
            {stat.deletions > 0 && <span className="diff-del">-{stat.deletions}</span>}
          </span>
        )}
        {isDirty && (
          <span className="tab-dirty-dot" title="未保存">
            ●
          </span>
        )}
      </button>
      <button
        aria-label={`关闭 ${file.path}`}
        disabled={savingFile}
        onClick={() => onClose(file.path)}
      >
        <X size={13} />
      </button>
    </div>
  );
});

function App() {
  const [config, setConfig] = useState<Config>({
    profiles: [],
    marketplaces: [],
    mcpServers: [],
    hooks: [],
    approvalMode: 'ask',
    approvedCommands: [],
  });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [view, setView] = useState<SessionView | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const busy = busySessionId !== null;
  const isCurrentBusy = Boolean(view && busySessionId === view.session.id);
  const isOtherBusy = Boolean(busySessionId && busySessionId !== view?.session.id);
  const [sending, setSending] = useState(false);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [fileSavedVersion, setFileSavedVersion] = useState(0);
  const [delivery, setDelivery] = useState<'steer' | 'follow-up'>('steer');
  const [stream, setStream] = useState('');
  const streamPendingRef = useRef('');
  const streamRafRef = useRef<number | null>(null);
  const [drafts, setDrafts] = useState(new Map<string, Map<string, ComposerDraft>>());
  const [maxModelCalls, setMaxModelCalls] = useState<24 | 96 | 240 | 480>(24);
  const [allowWorkspaceEdits, setAllowWorkspaceEdits] = useState(false);
  const [unattended, setUnattended] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalScope, setApprovalScope] = useState<ApprovalScope>('once');
  const [sessionApprovedCommands, setSessionApprovedCommands] = useState<[string, string][]>([]);
  const [dialog, setDialog] = useState<
    | 'model'
    | 'new'
    | 'skills'
    | 'appearance'
    | 'runtime'
    | 'preferences'
    | 'approvals'
    | 'memory'
    | null
  >(null);
  const [iconBackground, setIconBackground] = useState('white');
  const [uiTheme, setUiTheme] = useState<'light' | 'dark'>('light');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [securityNotice, setSecurityNotice] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [savingFile, setSavingFile] = useState(false);
  const fileOperation = useRef(false);
  const [fileTransitioning, setFileTransitioning] = useState(false);
  const [fileDecision, setFileDecision] = useState<FileDecision | null>(null);
  const allowWindowClose = useRef(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelDiscoveryError, setModelDiscoveryError] = useState('');
  const [modelLoading, setModelLoading] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);
  const forceModelRefresh = useRef(false);
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const selected = useRef<string | null>(null);
  const viewRevision = useRef(0);
  const errorTimer = useRef<number | undefined>(undefined);
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const bottom = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const isCurrentView = (revision: number, sessionId: string) =>
    viewRevision.current === revision && selected.current === sessionId;
  const draft = (view && drafts.get(view.session.id)?.get(view.session.workspace)) ?? emptyDraft;
  const { composer, attachments, quote } = draft;

  const updateDraft = useCallback(
    (session: Session, update: (previous: ComposerDraft) => ComposerDraft) => {
      setDrafts((previous) => {
        const workspaces = new Map(previous.get(session.id));
        const before = workspaces.get(session.workspace) ?? emptyDraft;
        const next = update(before);
        if (before === next) return previous;
        if (next.composer || next.attachments.length || next.quote)
          workspaces.set(session.workspace, next);
        else workspaces.delete(session.workspace);
        const result = new Map(previous);
        if (workspaces.size) result.set(session.id, workspaces);
        else result.delete(session.id);
        return result;
      });
    },
    [],
  );

  const dismissError = useCallback(() => {
    if (errorTimer.current !== undefined) {
      window.clearTimeout(errorTimer.current);
      errorTimer.current = undefined;
    }
    setError('');
  }, []);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
    if (errorTimer.current !== undefined) window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => {
      errorTimer.current = undefined;
      setError('');
    }, 6500);
  }, []);
  useEffect(
    () => () => {
      if (errorTimer.current !== undefined) window.clearTimeout(errorTimer.current);
    },
    [],
  );
  async function refreshSessions() {
    setSessions(await api<Session[]>('listSessions'));
  }
  async function deleteSession(id: string) {
    async function remove() {
      const remaining = await api<Session[]>('deleteSession', { sessionId: id });
      setSessions(remaining);
      setDeletingSession(null);
      setDrafts((previous) => {
        const result = new Map(previous);
        result.delete(id);
        return result;
      });
      if (selected.current !== id) return;
      viewRevision.current++;
      selected.current = null;
      setView(null);
      setOpenFiles([]);
      setActiveFile(null);
      if (remaining[0])
        showSession(await api<SessionView>('openSession', { sessionId: remaining[0].id }));
    }
    if (selected.current === id) {
      await protectFileEdits(remove);
      return;
    }
    try {
      await remove();
    } catch (err) {
      fail(err);
    }
  }
  function showSession(result: SessionView) {
    autoScrollRef.current = true;
    selected.current = result.session.id;
    setView(result);
    setOpenFiles([]);
    setActiveFile(null);
    setMaxModelCalls(24);
    setAllowWorkspaceEdits(false);
    setUnattended(false);
    setStream('');
    setSidebarOpen(false);
    if (result.recoveredUnknown)
      setNotice(`已发现 ${result.recoveredUnknown} 个结果未知的工具调用，请检查工作区。`);
  }
  async function createNewSession(workspace = '', profileAlias?: string) {
    if (busy) return;
    if (!config.profiles.length) {
      setDialog('model');
      return;
    }
    await protectFileEdits(async () => {
      const alias = profileAlias ?? config.defaultProfile ?? config.profiles[0]?.alias ?? '';
      const result = await api<SessionView>('createSession', { workspace, profileAlias: alias });
      setSessions((previous) => [result.session, ...previous]);
      viewRevision.current++;
      showSession(result);
      setDialog(null);
    });
  }
  async function openSession(id: string) {
    if (id === selected.current) return;
    await protectFileEdits(async () => {
      viewRevision.current++;
      const result = await api<SessionView>('openSession', { sessionId: id });
      showSession(result);
    });
  }
  async function refreshView(method: string, params: Record<string, unknown> = {}) {
    if (!view) return false;
    const revision = viewRevision.current;
    try {
      const next = await api<SessionView>(method, { ...params, sessionId: view.session.id });
      if (!isCurrentView(revision, view.session.id)) return false;
      setView(next);
      return next;
    } catch (error) {
      if (!isCurrentView(revision, view.session.id)) return false;
      throw error;
    }
  }
  async function openFile(path: string, review = false) {
    if (!view || fileOperation.current) return;
    const revision = viewRevision.current;
    try {
      const file = await api<{
        path: string;
        content: string;
        truncated: boolean;
        baselineContent?: string;
        readOnlyReason?: string;
      }>(review ? 'readWorkspaceReview' : 'readWorkspaceFile', {
        sessionId: view.session.id,
        path,
      });
      if (!isCurrentView(revision, view.session.id) || fileOperation.current) return;
      setOpenFiles((current) => {
        const existing = current.find((item) => item.path === path);
        // Keep the original save precondition while the editor has unsaved changes.
        if (existing && existing.content !== existing.originalContent)
          return review
            ? current.map((item) => (item.path === path ? { ...item, mode: 'diff' } : item))
            : current;
        const eol: '\r\n' | '\n' = file.content.includes('\r\n') ? '\r\n' : '\n';
        const normalizedContent = normalizeLineEndings(file.content);
        const normalizedBaseline =
          file.baselineContent !== undefined
            ? normalizeLineEndings(file.baselineContent)
            : normalizedContent;
        const openItem: OpenFile = {
          path: file.path,
          content: normalizedContent,
          originalContent: normalizedContent,
          originalDiskContent: file.content,
          baselineContent: normalizedBaseline,
          eol,
          truncated: file.truncated,
          mode: review ? 'diff' : (existing?.mode ?? 'edit'),
          readOnlyReason: file.readOnlyReason,
        };
        return [...current.filter((item) => item.path !== path), openItem];
      });
      setActiveFile(path);
    } catch (err) {
      if (isCurrentView(revision, view.session.id)) fail(err);
    }
  }

  async function persistFile(file: OpenFile) {
    if (!view) throw new Error('未打开会话');
    if (file.readOnlyReason) throw new Error(file.readOnlyReason);
    if (file.truncated) throw new Error('截断预览不能覆盖保存，请使用外部编辑器修改完整文件。');
    const revision = viewRevision.current;
    const nextDiskContent = restoreLineEndings(file.content, file.eol);
    await api('writeWorkspaceFile', {
      sessionId: view.session.id,
      path: file.path,
      content: nextDiskContent,
      expectedContent:
        file.originalDiskContent ?? restoreLineEndings(file.originalContent, file.eol),
    });
    if (!isCurrentView(revision, view.session.id)) return;
    setOpenFiles((current) =>
      current.map((item) =>
        item.path === file.path && item.originalContent === file.originalContent
          ? { ...item, originalContent: file.content, originalDiskContent: nextDiskContent }
          : item,
      ),
    );
    setFileSavedVersion((v) => v + 1);
    setNotice(`已保存 ${short(file.path)}`);
  }

  async function saveFile(file: OpenFile) {
    if (fileOperation.current) return;
    fileOperation.current = true;
    setSavingFile(true);
    try {
      await persistFile(file);
    } catch (err) {
      fail(err);
    } finally {
      fileOperation.current = false;
      setSavingFile(false);
    }
  }

  async function protectFileEdits(action: () => void | Promise<void>, path?: string) {
    if (fileOperation.current || sending) return;
    fileOperation.current = true;
    setFileTransitioning(true);
    try {
      const dirty = openFiles.filter(
        (file) =>
          (path === undefined || file.path === path) && file.content !== file.originalContent,
      );
      if (dirty.length) {
        const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) =>
          setFileDecision({ paths: dirty.map((file) => file.path), resolve }),
        );
        if (choice === 'cancel') return;
        if (choice === 'save') {
          for (const file of dirty) await persistFile(file);
        }
      }
      await action();
    } catch (err) {
      fail(err);
    } finally {
      fileOperation.current = false;
      setFileTransitioning(false);
    }
  }

  function revertFile(file: OpenFile) {
    setOpenFiles((current) =>
      current.map((item) =>
        item.path === file.path ? { ...item, content: item.originalContent } : item,
      ),
    );
  }

  function updateFileContent(path: string, content: string) {
    setOpenFiles((current) =>
      current.map((item) => (item.path === path ? { ...item, content } : item)),
    );
  }

  function setFileMode(path: string, mode: 'edit' | 'diff') {
    setOpenFiles((current) =>
      current.map((item) => (item.path === path ? { ...item, mode } : item)),
    );
  }
  async function changeWorkspace() {
    if (!view || busy || fileOperation.current || sending) return;
    const revision = viewRevision.current;
    try {
      const workspace = await api<string | null>('chooseWorkspace');
      if (
        !workspace ||
        (workspace === view.session.workspace && !view.session.managedWorkspace) ||
        !isCurrentView(revision, view.session.id)
      )
        return;
      await protectFileEdits(async () => {
        viewRevision.current++;
        const next = await api<SessionView>('setWorkspace', {
          sessionId: view.session.id,
          workspace,
        });
        setView(next);
        if (next.session.workspace !== view.session.workspace) {
          viewRevision.current++;
          setOpenFiles([]);
          setActiveFile(null);
        }
        await refreshSessions();
      });
    } catch (err) {
      if (isCurrentView(revision, view.session.id)) fail(err);
    }
  }
  const protectFileEditsRef = useRef(protectFileEdits);
  protectFileEditsRef.current = protectFileEdits;
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (allowWindowClose.current) {
        allowWindowClose.current = false;
        return;
      }
      if (
        !fileOperation.current &&
        !openFilesRef.current.some((file) => file.content !== file.originalContent)
      )
        return;
      event.preventDefault();
      event.returnValue = '';
      void protectFileEditsRef.current(() => {
        allowWindowClose.current = true;
        window.close();
      });
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  useEffect(() => {
    let disposed = false;
    void api<{ iconBackground: string; uiTheme: 'light' | 'dark' }>('getAppearance')
      .then((data) => {
        if (!disposed) {
          setIconBackground(data.iconBackground);
          setUiTheme(data.uiTheme);
        }
      })
      .catch(fail);
    void api<{
      config: Config;
      sessions: Session[];
      skills: Skill[];
      busySessionId?: string;
      legacyKeyExposure?: boolean;
    }>('bootstrap')
      .then((data) => {
        if (disposed) return;
        setConfig(data.config);
        setSessions(data.sessions);
        setSkills(data.skills);
        setBusySessionId(data.busySessionId ?? null);
        if (data.legacyKeyExposure)
          setSecurityNotice(
            '检测到旧版本曾保存 API Key。请在服务商后台轮换该密钥；旧数据库页和备份可能仍有副本。',
          );
        if (data.sessions[0]) void openSession(data.sessions[0].id);
        else if (!data.config.profiles.length) setDialog('model');
      })
      .catch(fail);
    const unsubscribe = window.bruin.onEvent((message) => {
      if (message.type === 'hostExited') {
        fail(new Error('Agent 后台进程已退出，请重新启动 Bruin'));
        setBusySessionId(null);
        setApproval(null);
        return;
      }
      if (message.type === 'approval' && message.approvalId && message.call && message.sessionId) {
        setApprovalScope('once');
        setApproval({
          approvalId: message.approvalId,
          call: message.call,
          sessionId: message.sessionId,
          workspace: message.workspace,
          reason: message.reason ?? '',
        });
        return;
      }
      if (message.type === 'notice' && !message.sessionId) {
        setNotice(message.message ?? '');
        return;
      }
      if (message.type === 'runStarted' && message.sessionId) {
        setBusySessionId(message.sessionId);
      }
      if (message.type === 'runFinished' || message.type === 'runFailed') {
        setBusySessionId((current) =>
          !message.sessionId || current === message.sessionId ? null : current,
        );
        setApproval((current) => (current?.sessionId === message.sessionId ? null : current));
        void refreshSessions().catch(fail);
        if (message.type === 'runFailed' && message.sessionId !== selected.current) {
          fail(new Error(message.message ?? '后台会话执行失败'));
        }
      }
      if (message.sessionId !== selected.current) return;
      const clearStreamBuffer = () => {
        streamPendingRef.current = '';
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
        setStream('');
      };
      if (message.type === 'runStarted') {
        setNotice('');
      }
      if (message.type === 'text') {
        streamPendingRef.current += message.delta ?? '';
        if (streamRafRef.current === null) {
          streamRafRef.current = requestAnimationFrame(() => {
            streamRafRef.current = null;
            const buffered = streamPendingRef.current;
            if (!buffered) return;
            streamPendingRef.current = '';
            setStream((previous) => previous + buffered);
          });
        }
      }
      if (message.type === 'notice') setNotice(message.message ?? '');
      if ((message.type === 'runCheckpoint' || message.type === 'queueUpdated') && message.events) {
        setView((previous) =>
          acceptsEventSnapshot(previous, message.sessionId!, message.events!)
            ? { ...previous!, events: message.events! }
            : previous,
        );
        clearStreamBuffer();
      }
      if (message.type === 'runFinished' || message.type === 'runFailed') {
        setMaxModelCalls(24);
        setAllowWorkspaceEdits(false);
        setUnattended(false);
        clearStreamBuffer();
        if (message.events)
          setView((previous) =>
            acceptsEventSnapshot(previous, message.sessionId!, message.events!)
              ? {
                  ...previous!,
                  events: message.events!,
                  needsReview: needsUnknownReview(message.events!),
                }
              : previous,
          );
        if (message.sessionId) {
          const revision = viewRevision.current;
          void api<SessionView>('openSession', { sessionId: message.sessionId })
            .then((next) => {
              if (isCurrentView(revision, message.sessionId!))
                setView((previous) =>
                  acceptsEventSnapshot(previous, next.session.id, next.events) ? next : previous,
                );
            })
            .catch(fail);
        }
        if (message.type === 'runFailed') fail(new Error(message.message ?? '执行失败'));
      }
    });
    return () => {
      disposed = true;
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
      streamPendingRef.current = '';
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme;
  }, [uiTheme]);
  const activeProfile = config.profiles.find((p) => p.alias === view?.session.profile.alias);
  const activeProfileKey = activeProfile
    ? `${activeProfile.alias}|${activeProfile.provider}|${activeProfile.baseUrl ?? ''}|${activeProfile.apiKeyEnv ?? ''}`
    : (view?.session.profile.alias ?? '');
  useEffect(() => {
    const alias = view?.session.profile.alias;
    if (!alias) {
      setDiscoveredModels([]);
      return;
    }
    let cancelled = false;
    const refresh = forceModelRefresh.current;
    forceModelRefresh.current = false;
    setModelLoading(true);
    setDiscoveredModels([]);
    setModelDiscoveryError('');
    void api<string[]>('discoverModels', { alias, refresh })
      .then((models) => {
        if (!cancelled) setDiscoveredModels(models);
      })
      .catch((err) => {
        if (!cancelled) setModelDiscoveryError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setModelLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfileKey, modelRefresh]);
  const handleConversationScroll = () => {
    const el = conversationRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = distanceToBottom <= 80;
  };
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const el = conversationRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    } else {
      bottom.current?.scrollIntoView();
    }
  }, [view?.events.length, stream, notice, approval]);

  async function send() {
    if (
      !view ||
      isOtherBusy ||
      pendingQuestion(view.events) ||
      (!composer.trim() && !attachments.length && !quote) ||
      sending ||
      fileOperation.current ||
      view.needsReview
    )
      return;
    const { session } = view;
    const text = composer.trim();
    const wasBusy = isCurrentBusy;
    const optimistic: SessionEvent = {
      seq: -Date.now(),
      type: 'user',
      at: new Date().toISOString(),
      payload: { text, attachments, quote },
    };
    setSending(true);
    if (!wasBusy) {
      viewRevision.current++;
      autoScrollRef.current = true;
      setBusySessionId(session.id);
      setView((previous) =>
        previous ? { ...previous, events: [...previous.events, optimistic] } : previous,
      );
    }
    const revision = viewRevision.current;
    try {
      const result = await api<{ queued?: boolean; events?: SessionEvent[] }>('send', {
        sessionId: session.id,
        prompt: text,
        attachments: attachments.map((item) => item.id),
        quoteSeq: quote?.seq,
        ...(wasBusy
          ? { delivery }
          : {
              maxModelCalls,
              allowWorkspaceEdits: maxModelCalls > 24 && allowWorkspaceEdits,
              unattended: maxModelCalls > 24 && unattended,
            }),
      });
      updateDraft(session, (current) => (current === draft ? emptyDraft : current));
      if (!wasBusy || !isCurrentView(revision, session.id)) return;
      if (result.events)
        setView((previous) =>
          acceptsEventSnapshot(previous, session.id, result.events!)
            ? { ...previous!, events: result.events! }
            : previous,
        );
      setNotice(result.queued ? '消息已排队，将在安全边界处理。' : '消息已开始处理。');
    } catch (err) {
      if (!wasBusy) setBusySessionId((current) => (current === session.id ? null : current));
      if (!isCurrentView(revision, session.id)) return;
      if (!wasBusy) {
        setView((previous) =>
          previous
            ? { ...previous, events: previous.events.filter((event) => event !== optimistic) }
            : previous,
        );
        await refreshView('openSession').catch(fail);
      }
      fail(err);
    } finally {
      setSending(false);
    }
  }
  async function chooseAttachments(kind: 'file' | 'folder') {
    if (!view) return;
    const revision = viewRevision.current;
    try {
      const imported = await api<AttachmentRef[]>('chooseAttachments', {
        sessionId: view.session.id,
        kind,
      });
      if (imported.length && isCurrentView(revision, view.session.id))
        updateDraft(view.session, (current) => ({
          ...current,
          attachments: [...current.attachments, ...imported].slice(0, 30),
        }));
    } catch (err) {
      if (isCurrentView(revision, view.session.id)) fail(err);
    }
  }
  async function cancel() {
    const sessionId = approval?.sessionId ?? busySessionId ?? view?.session.id;
    if (sessionId)
      try {
        await api('cancel', { sessionId });
      } catch (err) {
        fail(err);
      }
  }
  async function decide(approved: boolean) {
    if (!approval) return;
    try {
      await api('answerApproval', {
        approvalId: approval.approvalId,
        approved,
        scope: approvalScope,
      });
      setApproval((current) => (current?.approvalId === approval.approvalId ? null : current));
      if (approved && approvalScope !== 'once') {
        const settings = await api<{ config: Config; sessionCommands: [string, string][] }>(
          'getApprovalSettings',
          { sessionId: approval.sessionId },
        );
        setConfig(settings.config);
        setSessionApprovedCommands(settings.sessionCommands);
      }
    } catch (err) {
      fail(err);
    }
  }
  async function openApprovalSettings() {
    try {
      const settings = await api<{ config: Config; sessionCommands: [string, string][] }>(
        'getApprovalSettings',
        { sessionId: view?.session.id },
      );
      setConfig(settings.config);
      setSessionApprovedCommands(settings.sessionCommands);
      setDialog('approvals');
    } catch (err) {
      fail(err);
    }
  }
  async function switchModel(modelId: string, alias?: string) {
    if (!view) return;
    try {
      await refreshView('setSessionModel', {
        alias: alias ?? view.session.profile.alias,
        modelId,
      });
      await refreshSessions();
    } catch (err) {
      fail(err);
    }
  }
  async function resume() {
    if (!view || busy || view.needsReview) return;
    const sessionId = view.session.id;
    try {
      setBusySessionId(sessionId);
      await api('resume', {
        sessionId,
        maxModelCalls,
        allowWorkspaceEdits: maxModelCalls > 24 && allowWorkspaceEdits,
        unattended: maxModelCalls > 24 && unattended,
      });
    } catch (err) {
      setBusySessionId((current) => (current === sessionId ? null : current));
      fail(err);
    }
  }
  async function finishPausedTurn() {
    if (!view || busy) return;
    try {
      await refreshView('finishPausedTurn');
    } catch (err) {
      fail(err);
    }
  }
  async function acknowledge() {
    if (!view) return;
    const throughSeq = unreviewedUnknownTools(view.events).at(-1)?.seq;
    if (throughSeq === undefined) return;
    try {
      const next = await refreshView('reviewUnknown', { throughSeq });
      if (next)
        setNotice(
          next.needsReview
            ? '还有新的未知工具结果，请检查后确认。'
            : '已确认检查工作区。可继续会话。',
        );
    } catch (err) {
      fail(err);
    }
  }
  async function planAction(method: string, params: Record<string, unknown>) {
    if (!view) return;
    try {
      await refreshView(method, params);
    } catch (err) {
      fail(err);
    }
  }
  const usage = useMemo(() => recordedUsage(view?.events ?? []), [view?.events]);
  const reviewTurns = useMemo(() => memoryReviewTurns(view?.events ?? []), [view?.events]);
  const groupedEvents = useMemo(
    () => (view ? groupConversationEvents(view.events) : []),
    [view?.events],
  );
  const currentSessionRef = useRef<Session | null>(null);
  currentSessionRef.current = view?.session ?? null;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const handleQuote = useCallback(
    (selectedEvent: SessionEvent) => {
      const currentSession = currentSessionRef.current;
      if (!currentSession || sendingRef.current) return;
      updateDraft(currentSession, (current) => ({
        ...current,
        quote: {
          seq: selectedEvent.seq,
          text: String(selectedEvent.payload.text ?? '').slice(0, 4000),
        },
      }));
    },
    [updateDraft],
  );
  const handleSelectFileTab = useCallback((path: string) => setActiveFile(path), []);
  const handleCloseFileTab = useCallback((path: string) => {
    void protectFileEditsRef.current(() => {
      setOpenFiles((current) => current.filter((file) => file.path !== path));
      setActiveFile((current) => (current === path ? null : current));
    }, path);
  }, []);
  const currentTurn = turnState(view?.events ?? []);
  const question = pendingQuestion(view?.events ?? []);
  const canResume = Boolean(view && !busy && canResumeTurn(view.events));
  const resumeLabel =
    currentTurn === 'paused'
      ? '继续任务'
      : currentTurn === 'unfinished'
        ? '继续未完成的运行'
        : '处理队列中的消息';

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} inert={fileTransitioning}>
        <div className="brand">
          <div className="brand-mark">
            <Code2 size={21} strokeWidth={2.4} />
          </div>
          <span>Bruin</span>
          <span className="brand-beta">DESKTOP</span>
        </div>
        <button
          className="new-task"
          disabled={busy}
          title={busy ? '当前任务完成后可新建会话' : undefined}
          onClick={() => void createNewSession()}
        >
          <Plus size={18} /> 新建会话
        </button>
        <div className="sidebar-label">
          最近会话 <span>{sessions.length}</span>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <div className="session-row" key={session.id}>
              <button
                className={`session-item ${view?.session.id === session.id ? 'active' : ''}`}
                onClick={() => void openSession(session.id)}
                disabled={isCurrentBusy && view?.session.id !== session.id}
              >
                <MessageSquare size={16} />
                <span className="session-copy">
                  <strong>
                    {sessionTitle(
                      session,
                      view?.session.id === session.id ? view.events : undefined,
                    )}
                  </strong>
                  <small>
                    {short(session.workspace)} · {date(session.updatedAt)}
                  </small>
                </span>
              </button>
              <button
                className="session-delete"
                aria-label={deletingSession === session.id ? '确认删除会话' : '删除会话'}
                title={deletingSession === session.id ? '再次点击，删除本地会话记录' : '删除会话'}
                disabled={busySessionId === session.id}
                onClick={() =>
                  deletingSession === session.id
                    ? void deleteSession(session.id)
                    : setDeletingSession(session.id)
                }
              >
                {deletingSession === session.id ? '确认删除' : <Trash2 size={15} />}
              </button>
            </div>
          ))}
          {!sessions.length && <div className="empty-sidebar">新建会话，开始协作。</div>}
        </div>
        {view && (
          <div className="workspace-explorer">
            <button className="explorer-toggle" onClick={() => setFilesOpen((open) => !open)}>
              {filesOpen ? <ChevronDown size={15} /> : <Folder size={15} />}
              项目文件 · {short(view.session.workspace)}
            </button>
            {filesOpen && (
              <div className="explorer-list" key={`${view.session.id}:${view.session.workspace}`}>
                <WorkspaceFolder
                  sessionId={view.session.id}
                  path=""
                  refresh={view.events.length}
                  fail={fail}
                  openFile={openFile}
                />
              </div>
            )}
          </div>
        )}
        <div className="sidebar-footer">
          <button onClick={() => void openApprovalSettings()}>
            <ShieldCheck size={17} /> 审批设置 {config.approvalMode === 'auto' ? '(自动)' : ''}
          </button>
          <button onClick={() => setDialog('appearance')}>
            <Palette size={17} /> 外观
          </button>
          <button onClick={() => setDialog('skills')}>
            <Layers size={17} /> Skills <span>{skills.filter((x) => x.enabled).length}</span>
          </button>
          <button onClick={() => setDialog('runtime')}>
            <Terminal size={17} /> MCP 与自动化
          </button>
          <button onClick={() => setDialog('preferences')}>
            <Sparkles size={17} /> 用户偏好
          </button>
          <button onClick={() => setDialog('model')}>
            <Settings2 size={17} /> 模型设置
          </button>
        </div>
      </aside>
      <main className="main-area" inert={fileTransitioning}>
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => {
              if (activeFile) {
                setActiveFile(null);
                return;
              }
              setSidebarOpen((open) => !open);
              setFilesOpen(true);
            }}
            aria-label={activeFile ? '返回对话' : '菜单'}
          >
            <Menu size={20} />
          </button>
          {activeFile && (
            <button className="chat-return" onClick={() => setActiveFile(null)}>
              <MessageSquare size={17} /> 返回对话
            </button>
          )}
          <div className="breadcrumb">
            <span>工作区</span>
            <span className="slash">/</span>
            <strong>{view ? short(view.session.workspace) : '欢迎使用 Bruin'}</strong>
          </div>
          <div className="header-actions">
            {view && (
              <button
                className="icon-button"
                title="整理会话记忆"
                aria-label="整理会话记忆"
                disabled={busy || !reviewTurns.length}
                onClick={() => setDialog('memory')}
              >
                <Sparkles size={17} />
              </button>
            )}
            {view && (
              <button
                className="workspace-path workspace-switch"
                title="更换此会话的项目文件夹"
                disabled={busy}
                onClick={() => void changeWorkspace()}
              >
                <FolderOpen size={14} />
                {view.session.workspace}
              </button>
            )}
            <div className="avatar">
              <img
                src={iconOptions.find((x) => x.id === iconBackground)?.image ?? bearWhite}
                alt="Bruin 熊图标"
              />
            </div>
          </div>
        </header>
        {view && openFiles.length > 0 && (
          <div className="editor-tabs" role="tablist" aria-label="会话与文件">
            <button
              role="tab"
              aria-selected={!activeFile}
              className={!activeFile ? 'active' : ''}
              onClick={() => setActiveFile(null)}
            >
              <MessageSquare size={14} /> 对话
            </button>
            {openFiles.map((file) => (
              <EditorTab
                key={file.path}
                file={file}
                active={activeFile === file.path}
                savingFile={savingFile}
                onSelect={handleSelectFileTab}
                onClose={handleCloseFileTab}
              />
            ))}
          </div>
        )}
        {securityNotice && (
          <div className="security-banner" role="alert">
            <ShieldCheck size={16} />
            <span>{securityNotice}</span>
            <button onClick={() => setSecurityNotice('')} aria-label="关闭提醒">
              <X size={14} />
            </button>
          </div>
        )}
        {!view ? (
          <div className="welcome">
            <div className="welcome-icon">
              <Sparkles size={34} />
            </div>
            <span className="eyebrow">YOUR LOCAL CODING AGENT</span>
            <h1>让想法，在代码中发生。</h1>
            <p>
              连接你熟悉的模型，新建会话后即可开始协作。Bruin
              会记录会话、展示工具操作，并在修改文件前征求许可。
            </p>
            <button className="primary" disabled={busy} onClick={() => void createNewSession()}>
              <Plus size={17} />
              {config.profiles.length ? '新建会话' : '先配置一个模型'}
            </button>
            <div className="welcome-features">
              <span>
                <ShieldCheck size={16} /> 工具审批
              </span>
              <span>
                <Layers size={16} /> 自定义 Skills
              </span>
              <span>
                <Terminal size={16} /> 本地执行
              </span>
            </div>
          </div>
        ) : activeFile && openFiles.find((file) => file.path === activeFile) ? (
          <FileEditorViewer
            key={activeFile}
            file={openFiles.find((file) => file.path === activeFile)!}
            onContentChange={(content) => updateFileContent(activeFile, content)}
            onSave={() => saveFile(openFiles.find((file) => file.path === activeFile)!)}
            onRevert={() => revertFile(openFiles.find((file) => file.path === activeFile)!)}
            onModeChange={(mode) => setFileMode(activeFile, mode)}
            saving={savingFile}
          />
        ) : (
          <>
            <div
              className="conversation-frame"
              key={`${view.session.id}:${view.session.workspace}`}
            >
              <div
                className="conversation"
                ref={conversationRef}
                onScroll={handleConversationScroll}
              >
                <div className="conversation-intro">
                  <div className="project-monogram">
                    {view.session.managedWorkspace
                      ? 'N'
                      : short(view.session.workspace).slice(0, 1).toUpperCase()}
                  </div>
                  <h1>
                    {view.session.managedWorkspace
                      ? `新会话 (${short(view.session.workspace)})`
                      : short(view.session.workspace)}
                  </h1>
                  <p>
                    {view.session.managedWorkspace
                      ? `${view.session.workspace}（待写入文件时真正创建）`
                      : view.session.workspace}
                  </p>
                  <span>
                    模型 {view.session.profile.alias} · 会话 {view.session.id.slice(0, 8)}
                  </span>
                  {usage.responses > 0 && (
                    <details className="session-usage">
                      <summary>
                        已记录 Token · 输入{' '}
                        {recordedTokenLabel(usage.inputTokens, usage.inputReports, usage.responses)}{' '}
                        · 输出{' '}
                        {recordedTokenLabel(
                          usage.outputTokens,
                          usage.outputReports,
                          usage.responses,
                        )}
                      </summary>
                      <p>
                        累计 {usage.responses} 次模型响应；其中 {usage.inputReports}{' '}
                        次提供输入用量、
                        {usage.outputReports} 次提供输出用量。≥ 表示仅统计已提供的部分。
                        不含上下文摘要、失败或中断请求及子 Agent
                        的用量；不是当前上下文占用或费用账单。
                      </p>
                    </details>
                  )}
                </div>
                {view.needsReview && (
                  <div className="review-banner">
                    <CircleAlert size={19} />
                    <div>
                      <strong>有工具操作的结果未知</strong>
                      <p>上次运行可能在工具执行中中断。请检查项目文件，再继续执行。</p>
                    </div>
                    <button disabled={busy} onClick={() => void acknowledge()}>
                      我已检查
                    </button>
                  </div>
                )}
                {(view.plan.enabled || view.plan.steps.length > 0) && (
                  <div className="plan-panel">
                    <div className="plan-heading">
                      <div className="plan-title-wrap">
                        <strong>规划模式</strong>
                        <span
                          className={`plan-badge ${view.plan.approved ? 'approved' : 'pending'}`}
                        >
                          {view.plan.approved ? '已批准' : '待批准'}
                        </span>
                      </div>
                      {view.plan.enabled && (
                        <button
                          className="secondary plan-close-btn"
                          disabled={busy}
                          onClick={() => void planAction('setPlanMode', { enabled: false })}
                          title="关闭规划模式"
                        >
                          关闭
                        </button>
                      )}
                    </div>
                    {view.plan.steps.length ? (
                      <ol>
                        {view.plan.steps.map((step, index) => (
                          <li key={`${index}-${step}`}>
                            <span>{step}</span>
                            {view.plan.approved && (
                              <select
                                value={view.plan.progress[index] ?? 'pending'}
                                onChange={(e) =>
                                  void planAction('setPlanProgress', {
                                    index,
                                    status: e.target.value,
                                  })
                                }
                              >
                                <option value="pending">待处理</option>
                                <option value="in_progress">进行中</option>
                                <option value="completed">已完成</option>
                              </select>
                            )}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>规划模式已开启。请在对话框发送任务，Bruin 将先制定详细计划供您审批。</p>
                    )}
                    {view.plan.steps.length > 0 && !view.plan.approved && (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => void planAction('approvePlan', {})}
                      >
                        批准计划并允许执行
                      </button>
                    )}
                    {view.plan.approved && <small>计划已批准。工具仍遵循当前审批设置。</small>}
                  </div>
                )}
                {groupedEvents.map((item) =>
                  item.kind === 'tools' ? (
                    <ToolActivity key={`tools-${item.events[0].seq}`} events={item.events} />
                  ) : (
                    <EventCard key={item.event.seq} event={item.event} onQuote={handleQuote} />
                  ),
                )}
                {stream && (
                  <div className="message assistant">
                    <div className="message-icon">
                      <Bot size={17} />
                    </div>
                    <div className="message-body">
                      <div className="message-author">
                        Bruin <span className="live-dot" />
                      </div>
                      <MarkdownMessage text={stream} />
                    </div>
                  </div>
                )}
                {isCurrentBusy && !stream && (
                  <div className="working">
                    <LoaderCircle className="spin" size={16} /> Bruin 正在处理…
                  </div>
                )}
                {notice && (
                  <div className="inline-notice">
                    <Terminal size={15} />
                    <span>{notice}</span>
                    <button onClick={() => setNotice('')} aria-label="关闭">
                      <X size={14} />
                    </button>
                  </div>
                )}
                {canResume && !view.needsReview && (
                  <div className="resume-actions">
                    <button className="resume-button" onClick={() => void resume()}>
                      <Sparkles size={16} /> {resumeLabel}
                    </button>
                    {currentTurn === 'paused' && (
                      <button className="secondary" onClick={() => void finishPausedTurn()}>
                        结束任务
                      </button>
                    )}
                  </div>
                )}
                <div ref={bottom} />
              </div>
              <WorkspaceReviewDock
                sessionId={view.session.id}
                refreshKey={`${view.events.length}:${fileSavedVersion}:${busy}`}
                openFile={(path) => openFile(path, true)}
              />
            </div>
            <div className="composer-wrap">
              {question && (
                <QuestionReply
                  key={question.id}
                  question={question.text}
                  context={question.context}
                  options={question.options}
                  kind={question.kind}
                  disabled={busy || view.needsReview}
                  answer={async (text) => {
                    const sessionId = view.session.id;
                    const revision = viewRevision.current;
                    const result = await api<{ started?: boolean; events?: SessionEvent[] }>(
                      'answerQuestion',
                      {
                        sessionId,
                        questionId: question.id,
                        text,
                        maxModelCalls,
                        allowWorkspaceEdits: maxModelCalls > 24 && allowWorkspaceEdits,
                        unattended: maxModelCalls > 24 && unattended,
                      },
                    );
                    setBusySessionId(sessionId);
                    if (result.events && isCurrentView(revision, sessionId)) {
                      setView((previous) =>
                        acceptsEventSnapshot(previous, sessionId, result.events!)
                          ? { ...previous!, events: result.events! }
                          : previous,
                      );
                    }
                  }}
                  finish={() => void finishPausedTurn()}
                  fail={fail}
                />
              )}
              <div className="composer">
                {(quote || attachments.length > 0) && (
                  <div className="composer-context" inert={sending}>
                    {quote && (
                      <span className="composer-chip">
                        <MessageSquare size={13} /> 引用：{quote.text.slice(0, 60) || '消息'}
                        <button
                          aria-label="移除引用"
                          onClick={() =>
                            updateDraft(view.session, (current) => ({ ...current, quote: null }))
                          }
                        >
                          <X size={13} />
                        </button>
                      </span>
                    )}
                    {attachments.map((item) => (
                      <span className="composer-chip" key={item.id} title={item.note}>
                        <Paperclip size={13} />
                        {item.name}
                        {item.note
                          ? item.note.startsWith('无法提取')
                            ? ' · 无法提取内容'
                            : item.note.includes('截断')
                              ? ' · 已截断'
                              : ' · 部分提取'
                          : ''}
                        <button
                          aria-label={`移除 ${item.name}`}
                          onClick={() =>
                            updateDraft(view.session, (current) => ({
                              ...current,
                              attachments: current.attachments.filter(
                                (file) => file.id !== item.id,
                              ),
                            }))
                          }
                        >
                          <X size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  value={composer}
                  onChange={(e) => {
                    const composer = e.target.value;
                    updateDraft(view.session, (current) => ({ ...current, composer }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={
                    view.needsReview
                      ? '请先检查并确认未知的工具操作'
                      : busy
                        ? '补充指令或排队下一项任务…'
                        : '给 Bruin 一个任务…'
                  }
                  disabled={Boolean(question) || view.needsReview || sending}
                />
                {pendingInputs(view.events).length > 0 && (
                  <div className="composer-queue" role="status">
                    待处理消息：{pendingInputs(view.events).length}{' '}
                    条；停止或重启后保留，可继续任务处理。
                  </div>
                )}
                <details className="long-run-settings">
                  <summary>
                    {maxModelCalls > 24
                      ? `长任务：最多 ${maxModelCalls} 次模型调用 / 8 小时${unattended ? ' · 无人值守' : ''}`
                      : '运行预算：标准 24 次模型调用'}
                  </summary>
                  <div className="long-run-controls">
                    <label>
                      本段模型调用上限
                      <select
                        value={maxModelCalls}
                        disabled={busy}
                        onChange={(event) => {
                          const next = Number(event.target.value) as 24 | 96 | 240 | 480;
                          setMaxModelCalls(next);
                          if (next === 24) setUnattended(false);
                        }}
                      >
                        <option value={24}>标准 · 24 次</option>
                        <option value={96}>长任务 · 96 次</option>
                        <option value={240}>长任务 · 240 次</option>
                        {unattended && <option value={480}>无人值守 · 480 次</option>}
                      </select>
                    </label>
                    {maxModelCalls > 24 && (
                      <>
                        <label className="long-run-write-choice">
                          <input
                            type="checkbox"
                            checked={allowWorkspaceEdits}
                            disabled={busy}
                            onChange={(event) => setAllowWorkspaceEdits(event.target.checked)}
                          />
                          本段自动批准工作区内的文件写入和编辑
                        </label>
                        <label className="long-run-write-choice">
                          <input
                            type="checkbox"
                            checked={unattended}
                            disabled={busy}
                            onChange={(event) => {
                              setUnattended(event.target.checked);
                              if (!event.target.checked && maxModelCalls === 480)
                                setMaxModelCalls(240);
                            }}
                          />
                          无人值守：未预先授权的操作立即拒绝，不等待审批
                        </label>
                      </>
                    )}
                    <small>
                      每 24 次记录检查点，最多运行 8
                      小时。模型调用数不是费用上限；自动写入可覆盖工作区文件。
                      无人值守模式下，Shell、MCP 等仍需预先授权，否则会被拒绝。
                    </small>
                  </div>
                </details>
                <div className="composer-bottom">
                  <div className="composer-left">
                    <button
                      type="button"
                      className="composer-action-btn"
                      title="添加图片、文档或文件"
                      aria-label="添加文件"
                      disabled={busy || sending}
                      onClick={() => void chooseAttachments('file')}
                    >
                      <Paperclip size={16} />
                    </button>
                    <button
                      type="button"
                      className="composer-action-btn"
                      title="添加文件夹"
                      aria-label="添加文件夹"
                      disabled={busy || sending}
                      onClick={() => void chooseAttachments('folder')}
                    >
                      <FolderOpen size={16} />
                    </button>
                    <button
                      type="button"
                      className={`composer-action-btn composer-mode-toggle ${config.approvalMode !== 'ask' ? 'active' : ''}`}
                      disabled={approvalSaving}
                      title={
                        config.approvalMode === 'auto'
                          ? '当前为【自动执行】模式（除恶意操作全自动，点击切换为每次询问）'
                          : config.approvalMode === 'autoSafe'
                            ? '当前为【只读免审】模式（点击切换为自动执行）'
                            : '当前为【每次询问】模式（点击切换为自动执行）'
                      }
                      aria-label="切换审批模式"
                      onClick={() => {
                        if (approvalSaving) return;
                        setApprovalSaving(true);
                        const nextMode = config.approvalMode === 'auto' ? 'ask' : 'auto';
                        void api<Config>('setApprovalMode', { mode: nextMode })
                          .then(setConfig)
                          .catch(fail)
                          .finally(() => setApprovalSaving(false));
                      }}
                    >
                      <ShieldCheck size={15} />
                      <span className="composer-mode-badge">
                        {config.approvalMode === 'auto'
                          ? '自动审批'
                          : config.approvalMode === 'autoSafe'
                            ? '只读免审'
                            : '手动审核'}
                      </span>
                    </button>
                  </div>
                  <div className="composer-right">
                    <div
                      className="composer-model-picker"
                      title={
                        modelDiscoveryError || (modelLoading ? '正在获取模型列表' : '切换当前模型')
                      }
                    >
                      <Sparkles size={13} className="composer-model-icon" />
                      <select
                        className="composer-model-select"
                        aria-label="切换模型"
                        value={JSON.stringify([
                          view.session.profile.alias,
                          view.session.profile.model,
                        ])}
                        onChange={(e) => {
                          try {
                            const [alias, mId] = JSON.parse(e.target.value) as [string, string];
                            void switchModel(mId, alias);
                          } catch {
                            void switchModel(e.target.value);
                          }
                        }}
                        disabled={busy || modelLoading}
                      >
                        {config.profiles.length > 1 ||
                        (config.profiles.length === 1 &&
                          config.profiles[0].alias !== view.session.profile.alias) ? (
                          <>
                            {!config.profiles.some(
                              (p) => p.alias === view.session.profile.alias,
                            ) && (
                              <optgroup
                                label={`${view.session.profile.alias} (${view.session.profile.provider} · 已删除)`}
                              >
                                <option
                                  value={JSON.stringify([
                                    view.session.profile.alias,
                                    view.session.profile.model,
                                  ])}
                                >
                                  {view.session.profile.model}
                                </option>
                              </optgroup>
                            )}
                            {config.profiles.map((p) => {
                              const isCurrent = p.alias === view.session.profile.alias;
                              const models = isCurrent
                                ? [...new Set([view.session.profile.model, ...discoveredModels])]
                                : [p.model];
                              return (
                                <optgroup label={`${p.alias} (${p.provider})`} key={p.alias}>
                                  {models.map((m) => {
                                    const val = JSON.stringify([p.alias, m]);
                                    return (
                                      <option value={val} key={val}>
                                        {m}
                                      </option>
                                    );
                                  })}
                                </optgroup>
                              );
                            })}
                          </>
                        ) : (
                          [...new Set([view.session.profile.model, ...discoveredModels])].map(
                            (id) => {
                              const val = JSON.stringify([view.session.profile.alias, id]);
                              return (
                                <option value={val} key={val}>
                                  {id}
                                </option>
                              );
                            },
                          )
                        )}
                      </select>
                      <ChevronDown size={11} className="composer-model-chevron" />
                    </div>

                    <button
                      type="button"
                      className="composer-icon-btn model-refresh"
                      aria-label="刷新可用模型"
                      title={modelDiscoveryError || '刷新可用模型'}
                      disabled={busy || modelLoading}
                      onClick={() => {
                        forceModelRefresh.current = true;
                        setModelRefresh((value) => value + 1);
                      }}
                    >
                      <LoaderCircle size={14} className={modelLoading ? 'spinning' : ''} />
                    </button>

                    {modelDiscoveryError &&
                      (modelDiscoveryError.includes('缺少 API Key') ? (
                        <button
                          type="button"
                          className="composer-key-btn"
                          onClick={() => setDialog('model')}
                          title="点击配置 API Key"
                        >
                          配置 Key
                        </button>
                      ) : (
                        <span className="composer-model-error" title={modelDiscoveryError}>
                          !
                        </span>
                      ))}

                    <div
                      role="switch"
                      aria-checked={view.plan.enabled}
                      tabIndex={0}
                      className={`composer-plan-toggle ${view.plan.enabled ? 'active' : ''} ${busy ? 'disabled' : ''}`}
                      title={
                        view.plan.enabled
                          ? '规划模式已开启：先制定计划并等待审批（点击关闭）'
                          : '规划模式已关闭：点击开启后将先制定执行计划'
                      }
                      onClick={() =>
                        !busy && void planAction('setPlanMode', { enabled: !view.plan.enabled })
                      }
                      onKeyDown={(e) => {
                        if ((e.key === ' ' || e.key === 'Enter') && !busy) {
                          e.preventDefault();
                          void planAction('setPlanMode', { enabled: !view.plan.enabled });
                        }
                      }}
                    >
                      <Layers size={13} className="plan-toggle-icon" />
                      <span className="plan-toggle-label">规划模式</span>
                      <span className={`plan-switch-track ${view.plan.enabled ? 'on' : 'off'}`}>
                        <span className="plan-switch-thumb" />
                      </span>
                    </div>

                    <span className="composer-hint" title="快捷键发送">
                      ⌘ ↵
                    </span>

                    {isCurrentBusy && (
                      <select
                        aria-label="消息处理时机"
                        value={delivery}
                        onChange={(e) => setDelivery(e.target.value as typeof delivery)}
                      >
                        <option value="steer">补充当前任务</option>
                        <option value="follow-up">当前任务结束后</option>
                      </select>
                    )}
                    <button
                      className="send-button"
                      title={
                        isOtherBusy
                          ? '其他会话正在运行任务'
                          : isCurrentBusy
                            ? '发送到队列 (⌘/Ctrl + Enter)'
                            : '发送 (⌘/Ctrl + Enter)'
                      }
                      disabled={
                        isOtherBusy ||
                        Boolean(question) ||
                        sending ||
                        (!composer.trim() && !attachments.length && !quote) ||
                        view.needsReview
                      }
                      onClick={() => void send()}
                    >
                      <Send size={15} />
                    </button>
                    {isCurrentBusy && (
                      <button
                        className="send-button stop"
                        title="停止运行"
                        onClick={() => void cancel()}
                      >
                        <Square size={15} fill="currentColor" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="composer-disclaimer">Bruin 可能出错。应用修改前请检查结果。</div>
            </div>
          </>
        )}
        {approval && (
          <div className="approval-dock" role="region" aria-label="工具操作审批">
            <div className="approval-panel">
              <div className="approval-head">
                <div className="approval-icon">
                  <ShieldCheck size={22} />
                </div>
                <div>
                  <span className="eyebrow">TOOL APPROVAL</span>
                  <h2>允许 Bruin 执行此操作？</h2>
                </div>
              </div>
              <p title={approval.workspace}>
                {approval.workspace ?? '工作区路径未提供'} · 会话 {approval.sessionId.slice(0, 8)}
              </p>
              <p>{approval.reason}</p>
              <div className="approval-name">
                <Terminal size={15} />
                {approval.call.name}
              </div>
              <pre>{JSON.stringify(approval.call.input, null, 2)}</pre>
              {approval.call.name === 'shell' && (
                <div className="approval-scope">
                  <label htmlFor="approval-scope">授权范围（仅对相同工作区中的完整命令生效）</label>
                  <select
                    id="approval-scope"
                    value={approvalScope}
                    onChange={(e) => setApprovalScope(e.target.value as ApprovalScope)}
                  >
                    <option value="once">仅本次</option>
                    <option value="session">本会话</option>
                    <option value="always">永久允许</option>
                  </select>
                </div>
              )}
              <div className="modal-actions">
                <button className="secondary" onClick={() => void decide(false)}>
                  拒绝
                </button>
                <button className="primary" onClick={() => void decide(true)}>
                  <Check size={16} /> 允许
                  {approvalScope === 'session' && approval.call.name === 'shell'
                    ? '本会话'
                    : approvalScope === 'always' && approval.call.name === 'shell'
                      ? '并记住'
                      : '本次操作'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
      {error && (
        <div className="toast error" role="alert">
          <CircleAlert size={16} />
          {error}
          <button onClick={dismissError} aria-label="关闭错误提示">
            <X size={14} />
          </button>
        </div>
      )}
      {dialog === 'approvals' && (
        <Modal title="免审批命令" eyebrow="APPROVAL SETTINGS" close={() => setDialog(null)}>
          <div className="form-stack">
            <label>Agent 审批模式</label>
            <select
              value={config.approvalMode}
              onChange={(e) =>
                void api<Config>('setApprovalMode', { mode: e.target.value })
                  .then(setConfig)
                  .catch(fail)
              }
            >
              <option value="ask">每次询问</option>
              <option value="autoSafe">自动执行固定只读命令</option>
              <option value="auto">自动执行（除高危与恶意操作）</option>
            </select>
            <p className="form-help">
              {config.approvalMode === 'auto'
                ? '自动审批模式（类似 Codex）：常规读写、构建测试及工具调用均自动执行，仅对高危或恶意命令（如破坏性删除、磁盘覆写等）进行拦截确认。'
                : config.approvalMode === 'autoSafe'
                  ? '只读免审模式仅自动允许 pwd、git status、git diff 等只读检查。其他修改和外部工具仍需审批。'
                  : '每次执行文件修改、Shell 命令或外部工具时均弹出提示由您审批。'}
            </p>
            <h3>永久允许的命令</h3>
            {config.approvedCommands.filter((rule) => !rule.sessionId).length ? (
              config.approvedCommands
                .filter((rule) => !rule.sessionId)
                .map((rule) => (
                  <div className="approved-command" key={`${rule.workspace}:${rule.command}`}>
                    <div>
                      <small>{rule.workspace}</small>
                      <code>{rule.command}</code>
                    </div>
                    <button
                      className="secondary"
                      onClick={() =>
                        void api<Config>('removeApprovedCommand', rule).then(setConfig).catch(fail)
                      }
                    >
                      撤销
                    </button>
                  </div>
                ))
            ) : (
              <p className="form-help">暂无永久授权。会话授权随会话保存。</p>
            )}
            <h3>本会话允许的命令</h3>
            {sessionApprovedCommands.length ? (
              sessionApprovedCommands.map(([workspace, command]) => (
                <div className="approved-command" key={`${workspace}:${command}`}>
                  <div>
                    <small>{workspace}</small>
                    <code>{command}</code>
                  </div>
                  <button
                    className="secondary"
                    onClick={() =>
                      void api('removeSessionCommand', {
                        sessionId: view?.session.id,
                        workspace,
                        command,
                      })
                        .then(() =>
                          setSessionApprovedCommands((rules) =>
                            rules.filter((rule) => rule[0] !== workspace || rule[1] !== command),
                          ),
                        )
                        .catch(fail)
                    }
                  >
                    撤销
                  </button>
                </div>
              ))
            ) : (
              <p className="form-help">暂无本会话授权。</p>
            )}
          </div>
        </Modal>
      )}
      {dialog === 'new' && (
        <NewSessionDialog
          profiles={config.profiles}
          defaultProfile={config.defaultProfile}
          close={() => setDialog(null)}
          create={createNewSession}
          fail={fail}
          openModels={() => setDialog('model')}
        />
      )}
      {dialog === 'model' && (
        <ModelDialog
          config={config}
          focusAlias={
            modelDiscoveryError.includes('缺少 API Key') ? view?.session.profile.alias : undefined
          }
          busy={busy}
          close={() => setDialog(null)}
          changed={(next) => {
            setConfig(next);
            void refreshSessions().catch(fail);
            if (view && !busy) void refreshView('openSession').catch(fail);
          }}
          fail={fail}
        />
      )}
      {dialog === 'appearance' && (
        <AppearanceDialog
          selected={iconBackground}
          uiTheme={uiTheme}
          close={() => setDialog(null)}
          changed={setIconBackground}
          themeChanged={setUiTheme}
          fail={fail}
        />
      )}
      {dialog === 'skills' && (
        <SkillsDialog
          skills={skills}
          markets={config.marketplaces}
          close={() => setDialog(null)}
          changed={setSkills}
          marketsChanged={(markets) =>
            setConfig((previous) => ({ ...previous, marketplaces: markets }))
          }
          fail={fail}
        />
      )}
      {dialog === 'runtime' && (
        <RuntimeDialog
          key={view ? `${view.session.id}:${view.session.workspace}` : undefined}
          config={config}
          session={view?.session}
          approvedPlanSeq={
            view?.plan.enabled && view.plan.approved
              ? [...view.events].reverse().find((event) => event.type === 'plan_updated')?.seq
              : undefined
          }
          close={() => setDialog(null)}
          changed={setConfig}
          fail={fail}
        />
      )}
      {dialog === 'preferences' && <PreferencesDialog close={() => setDialog(null)} fail={fail} />}
      {dialog === 'memory' && view && (
        <MemoryReviewDialog
          key={`${view.session.id}:${view.session.workspace}`}
          session={view.session}
          turns={reviewTurns}
          close={() => setDialog(null)}
          saved={() => {
            setNotice('工作区记忆已保存');
            void refreshView('openSession').catch(fail);
          }}
        />
      )}
      {fileDecision && (
        <UnsavedFilesDialog
          paths={fileDecision.paths}
          choose={(choice) => {
            setFileDecision(null);
            fileDecision.resolve(choice);
          }}
        />
      )}
    </div>
  );
}

function WorkspaceFolder({
  sessionId,
  path,
  refresh,
  fail,
  openFile,
}: {
  sessionId: string;
  path: string;
  refresh: number;
  fail: (error: unknown) => void;
  openFile: (path: string) => Promise<void>;
}) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<WorkspaceEntry[]>('listWorkspaceEntries', { sessionId, path })
      .then((items) => {
        if (!cancelled) setEntries(items);
      })
      .catch((err) => {
        if (!cancelled) fail(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, refresh]);
  return (
    <div className="explorer-children">
      {loading && <small>正在读取…</small>}
      {!loading && !entries.length && <small>空文件夹</small>}
      {!loading && entries.length === 300 && <small>仅显示前 300 项</small>}
      {entries.map((entry) => (
        <React.Fragment key={entry.path}>
          <button
            className="explorer-entry"
            title={entry.path}
            onClick={() => {
              if (entry.kind === 'directory')
                setExpanded((current) =>
                  current.includes(entry.path)
                    ? current.filter((item) => item !== entry.path)
                    : [...current, entry.path],
                );
              else void openFile(entry.path);
            }}
          >
            {entry.kind === 'directory' ? (
              expanded.includes(entry.path) ? (
                <ChevronDown size={14} />
              ) : (
                <Folder size={14} />
              )
            ) : (
              <FileText size={14} />
            )}
            <span>{entry.name}</span>
          </button>
          {entry.kind === 'directory' && expanded.includes(entry.path) && (
            <WorkspaceFolder
              sessionId={sessionId}
              path={entry.path}
              refresh={refresh}
              fail={fail}
              openFile={openFile}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function WorkspaceReviewDock({
  sessionId,
  refreshKey,
  openFile,
}: {
  sessionId: string;
  refreshKey: string;
  openFile: (path: string) => Promise<void>;
}) {
  const [changes, setChanges] = useState<
    { path: string; source: 'agent' | 'workspace'; status: 'added' | 'modified' | 'deleted' }[]
  >([]);
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void api<typeof changes>('listWorkspaceChanges', { sessionId })
      .then((next) => {
        if (!cancelled) {
          setChanges(next);
          setError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey, refresh]);
  return (
    <aside
      className={`workspace-review-dock ${expanded ? 'expanded' : ''}`}
      aria-label="文件变更审核"
    >
      <div className="workspace-review-heading">
        <button
          className="workspace-review-toggle"
          aria-expanded={expanded}
          aria-controls="workspace-review-files"
          onClick={() => setExpanded((value) => !value)}
        >
          <GitCompare size={16} />
          <strong>文件变更</strong>
          <span>{changes.length}</span>
          <ChevronDown size={14} />
        </button>
        <button
          className="icon-button"
          aria-label="刷新文件变更"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RotateCcw size={14} />
        </button>
      </div>
      {expanded && (
        <div id="workspace-review-files" className="workspace-review-body">
          <p>本会话写入与工作区未提交修改 · 点击审核</p>
          {error ? (
            <p role="alert">{error}</p>
          ) : changes.length ? (
            <ul>
              {changes.map((file) => (
                <li key={file.path}>
                  <button onClick={() => void openFile(file.path)} title={file.path}>
                    <FileCode size={14} />
                    <span className="workspace-review-path">{file.path}</span>
                    <span className={`workspace-review-status ${file.status}`}>
                      {file.status === 'added'
                        ? '新增'
                        : file.status === 'deleted'
                          ? '删除'
                          : '修改'}
                    </span>
                    <small>{file.source === 'agent' ? 'Agent' : '工作区'}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="workspace-review-empty">暂无文件变更</div>
          )}
        </div>
      )}
    </aside>
  );
}

function PreferencesDialog({ close, fail }: { close: () => void; fail: (error: unknown) => void }) {
  const [items, setItems] = useState<UserPreference[]>([]);
  const [confirmId, setConfirmId] = useState('');
  useEffect(() => {
    void api<UserPreference[]>('listPreferences').then(setItems).catch(fail);
  }, []);
  return (
    <Modal title="用户偏好" eyebrow="LOCAL MEMORY" close={close}>
      <p>对话中明确表达的长期偏好保存在本机 SQLite，并在后续会话中按需加入提示词。</p>
      {!items.length && <p>还没有保存的偏好。</p>}
      {items.map((item) => (
        <div className="preference-row" key={item.id}>
          <span>{item.content}</span>
          <button
            onClick={() => {
              if (confirmId !== item.id) {
                setConfirmId(item.id);
                return;
              }
              void api<UserPreference[]>('deletePreference', { id: item.id })
                .then((next) => {
                  setItems(next);
                  setConfirmId('');
                })
                .catch(fail);
            }}
          >
            {confirmId === item.id ? '确认删除' : '删除'}
          </button>
        </div>
      ))}
    </Modal>
  );
}

function MemoryReviewDialog({
  session,
  turns,
  close,
  saved,
}: {
  session: Session;
  turns: MemoryReviewTurn[];
  close: () => void;
  saved: () => void;
}) {
  const [endSeq, setEndSeq] = useState(turns.at(-1)?.endSeq);
  const [preview, setPreview] = useState<MemoryReviewPreview>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const [generating, setGenerating] = useState(false);

  async function generate() {
    setPreview(undefined);
    setError('');
    setStatus('');
    setPending(true);
    setGenerating(true);
    try {
      setPreview(
        await api<MemoryReviewPreview>('previewMemoryReview', { sessionId: session.id, endSeq }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
      setPending(false);
    }
  }

  async function confirm(key: string) {
    if (!preview) return;
    setError('');
    setPending(true);
    try {
      const result = await api<{ output: string; isError: boolean }>('confirmMemoryCandidate', {
        sessionId: session.id,
        reviewId: preview.id,
        key,
      });
      if (result.isError) throw new Error(result.output);
      setPreview({ ...preview, candidates: preview.candidates.filter((item) => item.key !== key) });
      setStatus(`已保存 ${key}`);
      saved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  async function discard() {
    if (generating) {
      void api('cancelMemoryReview', {}).catch(() => {});
      close();
      return;
    }
    if (pending) return;
    setPending(true);
    try {
      if (preview)
        await api('discardMemoryReview', { sessionId: session.id, reviewId: preview.id });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  }

  return (
    <Modal title="整理会话记忆" eyebrow="工作区记忆" close={() => void discard()}>
      <div className="form-stack">
        <label htmlFor="memory-review-turn">选择已结束的回合</label>
        <select
          id="memory-review-turn"
          value={endSeq}
          disabled={pending || Boolean(preview?.candidates.length)}
          onChange={(event) => setEndSeq(Number(event.target.value))}
        >
          {[...turns].reverse().map((turn) => (
            <option key={turn.endSeq} value={turn.endSeq}>
              {date(turn.at)} · {turn.label || `回合 #${turn.endSeq}`}
            </option>
          ))}
        </select>
        <p className="form-help">
          使用当前模型整理本轮的消息和命令结果。保存的记忆供此工作区的后续会话查阅。
        </p>
      </div>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      {preview && !preview.candidates.length && !status && <p>本轮没有可保存的记忆候选。</p>}
      {preview?.candidates.map((item) => (
        <section className="memory-candidate" key={item.key}>
          <strong>{item.key}</strong>
          {item.previousContent !== undefined && (
            <details open>
              <summary>现有记忆</summary>
              <div className="memory-candidate-text">{item.previousContent}</div>
            </details>
          )}
          {item.previousContent !== undefined && <small>拟保存内容</small>}
          <div className="memory-candidate-text">{item.content}</div>
          <details open>
            <summary>原始证据</summary>
            <small>会话 {session.id}</small>
            <ul>
              {item.evidence.map((evidence) => (
                <li key={evidence.seq}>
                  <div>
                    #{evidence.seq} ·{' '}
                    {evidence.kind === 'user'
                      ? '用户消息'
                      : `命令 #${evidence.commandSeq} · 退出码 ${evidence.exitCode}${evidence.isError ? ' · 执行失败' : ''}`}
                  </div>
                  <div className="memory-candidate-text">{evidence.text}</div>
                </li>
              ))}
            </ul>
          </details>
          <button className="secondary" disabled={pending} onClick={() => void confirm(item.key)}>
            {item.previousContent === undefined ? '确认保存' : '确认更新'}
          </button>
        </section>
      ))}
      <div className="modal-actions">
        <button
          className="secondary"
          disabled={pending && !generating}
          onClick={() => void discard()}
        >
          {generating ? '取消生成' : preview?.candidates.length ? '放弃未保存候选' : '关闭'}
        </button>
        <button
          className="primary"
          disabled={pending || endSeq === undefined}
          onClick={() => void generate()}
        >
          {pending ? '处理中…' : preview ? '重新生成' : '生成候选'}
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  eyebrow,
  close,
  children,
}: {
  title: string;
  eyebrow: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-top">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={close}>
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function UnsavedFilesDialog({
  paths,
  choose,
}: {
  paths: string[];
  choose: FileDecision['resolve'];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal unsaved-files-dialog"
      aria-labelledby="unsaved-files-title"
      onCancel={(event) => {
        event.preventDefault();
        choose('cancel');
      }}
    >
      <h2 id="unsaved-files-title">文件有未保存的修改</h2>
      <ul>
        {paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      <div className="modal-actions">
        <button autoFocus className="secondary" onClick={() => choose('cancel')}>
          取消
        </button>
        <button className="secondary" onClick={() => choose('discard')}>
          放弃修改
        </button>
        <button className="primary" onClick={() => choose('save')}>
          保存并继续
        </button>
      </div>
    </dialog>
  );
}

type PatchCandidate = { id: string; prompt: string; baseCommit: string; running: boolean };

function QuestionReply({
  question,
  context,
  options,
  kind,
  disabled,
  answer,
  finish,
  fail,
}: {
  question: string;
  context?: string;
  options?: string[];
  kind?: string;
  disabled: boolean;
  answer: (text: string) => Promise<unknown>;
  finish: () => void;
  fail: (error: unknown) => void;
}) {
  const inputId = useId();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submitAnswer = (value: string) => {
    if (disabled || submitting || !value.trim()) return;
    setSubmitting(true);
    void answer(value)
      .catch(fail)
      .finally(() => setSubmitting(false));
  };
  const kindLabels: Record<string, string> = {
    clarification: '需要澄清',
    decision: '需要决策',
    confirmation: '需要确认',
  };
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submitAnswer(text);
      }}
    >
      <div>
        <label htmlFor={inputId}>
          {kind && kindLabels[kind] ? `[${kindLabels[kind]}] ` : ''}
          {question}
        </label>
        {context && <small className="question-context">{context}</small>}
        {options && options.length > 0 && (
          <div className="runtime-row question-options" role="group" aria-label="快捷选项">
            {options.map((option, index) => (
              <button
                key={`${index}-${option}`}
                type="button"
                disabled={disabled || submitting}
                onClick={() => submitAnswer(option)}
              >
                {index + 1}. {option}
              </button>
            ))}
          </div>
        )}
        <textarea
          id={inputId}
          aria-label="答复待答问题"
          placeholder={options?.length ? '点击上方选项或输入自定义答复…' : undefined}
          value={text}
          maxLength={10_000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              submitAnswer(text);
            }
          }}
          disabled={disabled || submitting}
        />
      </div>
      <div className="runtime-row">
        <button type="submit" disabled={disabled || submitting || !text.trim()}>
          答复并继续
        </button>
        <button type="button" disabled={disabled || submitting} onClick={finish}>
          结束任务
        </button>
      </div>
    </form>
  );
}

function RuntimeDialog({
  config,
  session,
  approvedPlanSeq,
  close,
  changed,
  fail,
}: {
  config: Config;
  session?: Session;
  approvedPlanSeq?: number;
  close: () => void;
  changed: (next: Config) => void;
  fail: (error: unknown) => void;
}) {
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [serverName, setServerName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [args, setArgs] = useState('');
  const [envName, setEnvName] = useState('');
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthPort, setOauthPort] = useState('');
  const [connectorTemplate, setConnectorTemplate] = useState('');
  const [indexQuery, setIndexQuery] = useState('');
  const [snapshots, setSnapshots] = useState<
    Array<{ id: string; path: string; at: string; action: string }>
  >([]);
  const [snapshotConfirm, setSnapshotConfirm] = useState('');
  const [snapshotOffset, setSnapshotOffset] = useState<number | null>(null);
  const [hookName, setHookName] = useState('');
  const [hookEvent, setHookEvent] = useState<Hook['event']>('before_tool');
  const [hookCommand, setHookCommand] = useState('');
  const [worktreeName, setWorktreeName] = useState('');
  const [worktreePath, setWorktreePath] = useState('');
  const [subagentPrompt, setSubagentPrompt] = useState('');
  const [subagentMode, setSubagentMode] = useState<'read-only' | 'worktree'>('read-only');
  const [subagentEdits, setSubagentEdits] = useState(false);
  const [subagentReviewPath, setSubagentReviewPath] = useState('');
  const [patchCandidates, setPatchCandidates] = useState<PatchCandidate[]>([]);
  const [selectedPatches, setSelectedPatches] = useState<string[]>([]);
  const [patchTestCommand, setPatchTestCommand] = useState('');
  const [backgroundCommand, setBackgroundCommand] = useState('');
  const [taskId, setTaskId] = useState('');
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [cronPrompt, setCronPrompt] = useState('');
  const [cronPlanSeq, setCronPlanSeq] = useState<number>();
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskDependencies, setTaskDependencies] = useState('');
  const [graphTaskId, setGraphTaskId] = useState('');
  const [graphTasks, setGraphTasks] = useState<TaskNode[]>([]);
  const [retryConfirmId, setRetryConfirmId] = useState('');
  const [memoryKey, setMemoryKey] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [webhookUrl, setWebhookUrl] = useState(config.webhookUrl ?? '');
  useEffect(() => {
    setWebhookUrl(config.webhookUrl ?? '');
  }, [config.webhookUrl]);
  useEffect(() => {
    if (!session) return;
    let active = true;
    void api<CronJob[]>('listCronJobs', { sessionId: session.id })
      .then((jobs) => {
        if (active) setCronJobs(jobs);
      })
      .catch((error) => {
        if (active) fail(error);
      });
    void api<TaskNode[]>('listTasks', { sessionId: session.id })
      .then((tasks) => {
        if (active) setGraphTasks(tasks);
      })
      .catch((error) => {
        if (active) fail(error);
      });
    void api<PatchCandidate[]>('listSubagentPatches', { sessionId: session.id })
      .then((candidates) => {
        if (active) setPatchCandidates(candidates);
      })
      .catch((error) => {
        if (active) fail(error);
      });
    return () => {
      active = false;
    };
  }, [session?.id]);
  const [output, setOutput] = useState('');
  const [working, setWorking] = useState(false);
  async function manage(method: string, params: Record<string, unknown>) {
    setWorking(true);
    try {
      const result = await api<unknown>(method, params);
      const latest = await api<{ config: Config }>('bootstrap');
      changed(latest.config);
      setOutput(JSON.stringify(result, null, 2));
    } catch (error) {
      fail(error);
    } finally {
      setWorking(false);
    }
  }
  async function runtime(name: string, input: Record<string, unknown> = {}) {
    if (!session) {
      fail(new Error('请先选择一个会话'));
      return;
    }
    setWorking(true);
    try {
      const result = await api<{ output: string; isError?: boolean }>('runtimeTool', {
        sessionId: session.id,
        name,
        input,
        ...(name === 'spawn_subagent'
          ? { allowWorkspaceEdits: subagentMode === 'worktree' && subagentEdits }
          : {}),
      });
      setOutput(result.output);
      if (!result.isError && name === 'list_snapshots') {
        const page = JSON.parse(result.output);
        setSnapshots((old) => (input.offset ? [...old, ...page.snapshots] : page.snapshots));
        setSnapshotOffset(page.nextOffset);
      }
      if (!result.isError && name === 'restore_snapshot') {
        setSnapshots([]);
        setSnapshotConfirm('');
      }
      if (name.endsWith('_task') || name === 'list_tasks')
        setGraphTasks(await api<TaskNode[]>('listTasks', { sessionId: session.id }));
      if (name === 'spawn_subagent') await refreshPatchCandidates();
    } catch (error) {
      fail(error);
    } finally {
      setWorking(false);
    }
  }
  async function exportSubagentPatch() {
    if (!session || !taskId.trim()) return;
    setWorking(true);
    try {
      const result = await api<{ path: string; baseCommit: string } | null>('exportSubagentPatch', {
        sessionId: session.id,
        childId: taskId.trim(),
      });
      if (result) setOutput(`补丁已保存到 ${result.path}\n基线提交 ${result.baseCommit}`);
    } catch (error) {
      fail(error);
    } finally {
      setWorking(false);
    }
  }
  async function refreshPatchCandidates() {
    if (!session) return;
    const candidates = await api<PatchCandidate[]>('listSubagentPatches', {
      sessionId: session.id,
    });
    setPatchCandidates(candidates);
    setSelectedPatches((current) =>
      current.filter((id) => candidates.some((item) => item.id === id && !item.running)),
    );
  }
  async function preflightPatches(testCommand?: string) {
    if (!session || selectedPatches.length < 2) return;
    setWorking(true);
    setOutput('正在临时工作树中检查补丁…');
    try {
      const result = await api<PatchPreflight | null>('preflightSubagentPatches', {
        sessionId: session.id,
        childIds: selectedPatches,
        testCommand,
      });
      if (!result) {
        setOutput('已取消本次预检。');
        return;
      }
      const heading =
        result.status === 'compatible'
          ? `${result.checked.length} 份补丁可一起应用。`
          : result.status === 'conflict'
            ? `补丁发生冲突，子任务 ${result.failedChildId}。`
            : `无法应用子任务 ${result.failedChildId} 的补丁。`;
      setOutput(
        [
          heading,
          `基线提交 ${result.baseCommit}`,
          ...result.conflictPaths,
          ...(result.detail ? ['', result.detail] : []),
          ...(result.test
            ? [
                '',
                result.test.isError ? '测试未通过。' : '测试通过。',
                ...(result.test.exitCode !== undefined && result.test.exitCode >= 0
                  ? [`退出码 ${result.test.exitCode}`]
                  : []),
                result.test.output,
              ]
            : []),
        ].join('\n'),
      );
    } catch (error) {
      setOutput('');
      fail(error);
    } finally {
      setWorking(false);
    }
  }
  async function createCron() {
    if (!session) return;
    setWorking(true);
    try {
      await api('createCronJob', {
        sessionId: session.id,
        expression: cronExpression,
        prompt: cronPrompt,
        planSeq: cronPlanSeq,
      });
      setCronJobs(await api<CronJob[]>('listCronJobs', { sessionId: session.id }));
      setCronPrompt('');
      setCronPlanSeq(undefined);
    } catch (error) {
      fail(error);
    } finally {
      setWorking(false);
    }
  }
  async function removeCron(id: string) {
    if (!session) return;
    setWorking(true);
    try {
      setCronJobs(await api<CronJob[]>('deleteCronJob', { sessionId: session.id, id }));
    } catch (error) {
      fail(error);
    } finally {
      setWorking(false);
    }
  }
  async function retryTask(id: string) {
    if (!session) return;
    if (retryConfirmId !== id) {
      setRetryConfirmId(id);
      return;
    }
    setWorking(true);
    try {
      setGraphTasks(await api<TaskNode[]>('retryTask', { sessionId: session.id, id }));
      setRetryConfirmId('');
    } catch (error) {
      fail(error);
    } finally {
      setWorking(false);
    }
  }
  return (
    <Modal title="MCP 与自动化" eyebrow="AGENT CAPABILITIES" close={close}>
      <div className="runtime-settings form-stack">
        <h3>人工注意通知 Webhook（可选）</h3>
        <div className="runtime-row">
          <input
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://hooks.example.com/bruin（仅支持 HTTPS 或本机 localhost）"
            maxLength={500}
            aria-label="通知 Webhook 地址"
          />
          <button
            type="button"
            disabled={working}
            onClick={() => void manage('setWebhookUrl', { url: webhookUrl })}
          >
            保存
          </button>
          {config.webhookUrl && (
            <button
              type="button"
              disabled={working}
              onClick={() => {
                setWebhookUrl('');
                void manage('setWebhookUrl', { url: '' });
              }}
            >
              清除
            </button>
          )}
        </div>
        <h3>仓库索引与文件快照</h3>
        <input
          value={indexQuery}
          onChange={(e) => setIndexQuery(e.target.value)}
          placeholder="文件路径或符号名称"
          maxLength={500}
          aria-label="仓库索引查询"
        />
        <button
          disabled={working || !session}
          onClick={() => void runtime('search_repository', { query: indexQuery })}
        >
          查询并更新索引
        </button>
        <button disabled={working || !session} onClick={() => void runtime('list_snapshots')}>
          列出文件快照
        </button>
        {snapshotOffset !== null && (
          <button
            disabled={working || !session}
            onClick={() => void runtime('list_snapshots', { offset: snapshotOffset })}
          >
            更多快照
          </button>
        )}
        {snapshots.map((snapshot) => (
          <div className="runtime-row" key={snapshot.id}>
            <span>
              {snapshot.path} · {snapshot.at} ·{' '}
              {snapshot.action === 'delete_created_file'
                ? '回滚将删除新建文件'
                : '回滚将恢复修改前内容'}
            </span>
            <button
              disabled={working}
              onClick={() => {
                if (snapshotConfirm !== snapshot.id) {
                  setSnapshotConfirm(snapshot.id);
                  return;
                }
                void runtime('restore_snapshot', { id: snapshot.id });
              }}
            >
              {snapshotConfirm === snapshot.id ? '确认回滚此文件' : '回滚'}
            </button>
          </div>
        ))}
        <small>
          仅覆盖 Bruin
          文件工具和桌面保存；Shell/MCP/外部编辑不自动生成快照。文件已有后续修改时拒绝回滚。
        </small>
        <h3>MCP 服务器</h3>
        <label>
          常用连接器
          <select
            value={connectorTemplate}
            disabled={working}
            onChange={(event) => {
              const template = connectorTemplates.find((item) => item.id === event.target.value);
              setConnectorTemplate(event.target.value);
              if (!template) return;
              setTransport('http');
              setServerName(template.id);
              setEndpoint(template.url);
              setEnvName(template.tokenEnv);
              setOauthEnabled(template.oauth);
              setOauthClientId('');
              setOauthPort('');
              setArgs('');
            }}
          >
            <option value="">自定义配置</option>
            {connectorTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        {connectorTemplates
          .filter((item) => item.id === connectorTemplate)
          .map((item) => (
            <small key={item.id}>
              {item.help}{' '}
              <a href={item.docs} target="_blank" rel="noreferrer">
                配置说明
              </a>
              。模板仅填充表单，保存后才生效。
            </small>
          ))}
        {config.mcpServers.map((server) => (
          <div className="runtime-row" key={server.name}>
            <span>
              <strong>{server.name}</strong> ·{' '}
              {server.transport === 'stdio' ? server.command : server.url}
            </span>
            {server.transport === 'http' && server.oauth && (
              <>
                <button
                  disabled={working}
                  onClick={() => void manage('loginMcpServer', { name: server.name })}
                >
                  OAuth 登录
                </button>
                <button
                  disabled={!working}
                  onClick={() => void api('cancelMcpLogin', { name: server.name }).catch(fail)}
                >
                  取消登录
                </button>
                <button
                  disabled={working}
                  onClick={() => void manage('logoutMcpServer', { name: server.name })}
                >
                  退出登录
                </button>
              </>
            )}
            <button
              disabled={working || (server.transport === 'stdio' && !session)}
              onClick={() =>
                void manage('testMcpServer', { name: server.name, sessionId: session?.id })
              }
            >
              测试工具
            </button>
            <button
              disabled={working}
              onClick={() => void manage('removeMcpServer', { name: server.name })}
            >
              移除
            </button>
          </div>
        ))}
        <label>
          传输方式
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
          >
            <option value="stdio">stdio 进程</option>
            <option value="http">Streamable HTTP</option>
          </select>
        </label>
        <label>
          名称
          <input
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            placeholder="filesystem"
          />
        </label>
        <label>
          {transport === 'stdio' ? '启动命令' : '服务器 URL'}
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={transport === 'stdio' ? 'npx' : 'https://example.com/mcp'}
          />
        </label>
        {transport === 'stdio' && (
          <label>
            参数（每行一个）
            <textarea
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
            />
          </label>
        )}
        {transport === 'http' && (
          <>
            <label>
              <input
                type="checkbox"
                checked={oauthEnabled}
                onChange={(e) => setOauthEnabled(e.target.checked)}
              />
              使用 OAuth 浏览器登录
            </label>
            {oauthEnabled && (
              <>
                <input
                  value={oauthClientId}
                  onChange={(e) => setOauthClientId(e.target.value)}
                  placeholder="预注册 Client ID（留空使用动态注册）"
                  aria-label="OAuth Client ID"
                />
                <input
                  value={oauthPort}
                  onChange={(e) => setOauthPort(e.target.value)}
                  placeholder="固定回调端口（留空使用随机端口）"
                  aria-label="OAuth 回调端口"
                />
                <small>
                  桌面端使用系统加密存储保存授权，支持重启恢复；退出登录会清除本机凭证。不写入配置或会话日志。
                </small>
              </>
            )}
          </>
        )}
        {!(transport === 'http' && oauthEnabled) && (
          <label>
            {transport === 'stdio'
              ? '允许传给服务器的环境变量名（逗号分隔）'
              : 'Bearer Token 环境变量名'}
            <input
              value={envName}
              onChange={(e) => setEnvName(e.target.value)}
              placeholder="MCP_TOKEN"
            />
          </label>
        )}
        <button
          className="secondary"
          disabled={working || !serverName.trim() || !endpoint.trim()}
          onClick={() =>
            void manage(
              'saveMcpServer',
              transport === 'stdio'
                ? {
                    name: serverName.trim(),
                    transport,
                    command: endpoint.trim(),
                    args: args
                      .split('\n')
                      .map((x) => x.trim())
                      .filter(Boolean),
                    envNames: envName
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  }
                : {
                    name: serverName.trim(),
                    transport,
                    url: endpoint.trim(),
                    ...(oauthEnabled
                      ? {
                          oauth: {
                            ...(oauthClientId.trim() ? { clientId: oauthClientId.trim() } : {}),
                            ...(oauthPort.trim() ? { callbackPort: Number(oauthPort) } : {}),
                          },
                        }
                      : envName.trim()
                        ? { tokenEnv: envName.trim() }
                        : {}),
                  },
            )
          }
        >
          保存 MCP 服务器
        </button>
        <h3>Hooks</h3>
        {config.hooks.map((hook) => (
          <div className="runtime-row" key={hook.name}>
            <span>
              <strong>{hook.name}</strong> · {hook.event} · {hook.enabled ? '启用' : '关闭'}
            </span>
            <button
              disabled={working}
              onClick={() => void manage('saveHook', { ...hook, enabled: !hook.enabled })}
            >
              {hook.enabled ? '关闭' : '启用'}
            </button>
            <button
              disabled={working}
              onClick={() => void manage('removeHook', { name: hook.name })}
            >
              移除
            </button>
          </div>
        ))}
        <label>
          Hook 名称
          <input value={hookName} onChange={(e) => setHookName(e.target.value)} />
        </label>
        <label>
          触发时机
          <select value={hookEvent} onChange={(e) => setHookEvent(e.target.value as Hook['event'])}>
            <option value="turn_started">回合开始</option>
            <option value="before_tool">工具执行前</option>
            <option value="after_tool">工具执行后</option>
            <option value="turn_finished">回合结束</option>
          </select>
        </label>
        <label>
          Shell 命令
          <input value={hookCommand} onChange={(e) => setHookCommand(e.target.value)} />
        </label>
        <button
          className="secondary"
          disabled={working || !hookName.trim() || !hookCommand.trim()}
          onClick={() =>
            void manage('saveHook', {
              name: hookName.trim(),
              event: hookEvent,
              command: hookCommand,
              enabled: true,
            })
          }
        >
          保存 Hook
        </button>
        <h3>定时任务</h3>
        {cronJobs.map((job) => (
          <div className="runtime-row" key={job.id}>
            <span>
              <strong>{job.expression}</strong> · {job.prompt} · 下次{' '}
              {new Date(job.nextRunAt).toLocaleString('zh-CN')} · {job.lastStatus ?? '待执行'}
              {job.planSeq !== undefined && ` · 计划版本 #${job.planSeq}`}
            </span>
            <button disabled={working} onClick={() => void removeCron(job.id)}>
              删除
            </button>
          </div>
        ))}
        <label>
          五段 Cron 表达式
          <input value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} />
        </label>
        <label>
          到点发送给 Agent 的消息
          <input value={cronPrompt} onChange={(e) => setCronPrompt(e.target.value)} />
        </label>
        {(approvedPlanSeq !== undefined || cronPlanSeq !== undefined) && (
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={cronPlanSeq !== undefined}
              onChange={(e) => setCronPlanSeq(e.target.checked ? approvedPlanSeq : undefined)}
            />
            {cronPlanSeq !== undefined && cronPlanSeq !== approvedPlanSeq
              ? `计划版本 #${cronPlanSeq} 已变更，请取消勾选后重新选择`
              : `关联已批准计划版本 #${approvedPlanSeq}`}
          </label>
        )}
        <button
          className="secondary"
          disabled={
            working ||
            !session ||
            !cronPrompt.trim() ||
            (cronPlanSeq !== undefined && cronPlanSeq !== approvedPlanSeq)
          }
          onClick={() => void createCron()}
        >
          添加定时任务
        </button>
        <small>桌面客户端运行时调度；工具调用仍需逐项批准。</small>
        <h3>任务图与本机进程认领</h3>
        <small>
          任务跨同一工作区的会话共享，并同步为工作区 .tasks/*.json；SQLite 负责原子认领。
        </small>
        {graphTasks.map((task) => (
          <div className="runtime-row" key={task.id}>
            <span>
              <strong>{task.title}</strong> · {task.status} · {task.id.slice(0, 8)} · 依赖{' '}
              {task.dependencies.length}
            </span>
            <button disabled={working} onClick={() => void runtime('get_task', { id: task.id })}>
              详情
            </button>
            {(task.status === 'unknown' || task.status === 'failed') && (
              <button disabled={working} onClick={() => void retryTask(task.id)}>
                {retryConfirmId === task.id ? '确认重试' : '检查后重试'}
              </button>
            )}
          </div>
        ))}
        <div className="runtime-row">
          <input
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
            placeholder="任务内容"
          />
          <input
            value={taskDependencies}
            onChange={(e) => setTaskDependencies(e.target.value)}
            placeholder="依赖任务 ID，逗号分隔"
          />
          <button
            disabled={working || !session || !taskTitle.trim()}
            onClick={() =>
              void runtime('create_task', {
                title: taskTitle,
                description: taskDescription,
                dependencies: taskDependencies
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          >
            添加任务
          </button>
        </div>
        <textarea
          value={taskDescription}
          onChange={(e) => setTaskDescription(e.target.value)}
          placeholder="任务详细描述（可选）"
        />
        <div className="runtime-row">
          <button disabled={working || !session} onClick={() => void runtime('list_tasks')}>
            查看任务图
          </button>
          <button
            disabled={working || !session}
            onClick={() => {
              if (!session) return;
              void api<TaskNode[]>('syncTasks', { sessionId: session.id })
                .then(setGraphTasks)
                .catch(fail);
            }}
          >
            修复 .tasks 快照
          </button>
          <button disabled={working || !session} onClick={() => void runtime('claim_task')}>
            认领就绪任务
          </button>
          <input
            value={graphTaskId}
            onChange={(e) => setGraphTaskId(e.target.value)}
            placeholder="已认领任务 ID"
          />
          <button
            disabled={working || !session || !graphTaskId.trim()}
            onClick={() => void runtime('finish_task', { id: graphTaskId, success: true })}
          >
            标记完成
          </button>
          <button
            disabled={working || !session || !graphTaskId.trim() || !taskDependencies.trim()}
            onClick={() =>
              void runtime('update_task', {
                id: graphTaskId,
                addBlockedBy: taskDependencies
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          >
            增加依赖
          </button>
        </div>
        <h3>工作区记忆</h3>
        <div className="runtime-row">
          <button disabled={working || !session} onClick={() => void runtime('list_memory')}>
            查看记忆
          </button>
          <input
            value={memoryKey}
            onChange={(e) => setMemoryKey(e.target.value)}
            placeholder="记忆名称"
          />
        </div>
        <textarea
          value={memoryContent}
          onChange={(e) => setMemoryContent(e.target.value)}
          placeholder="项目约定或背景信息"
        />
        <button
          className="secondary"
          disabled={working || !session || !memoryKey.trim() || !memoryContent.trim()}
          onClick={() => void runtime('save_memory', { key: memoryKey, content: memoryContent })}
        >
          保存工作区记忆
        </button>
        <h3>工作树与后台任务</h3>
        <div className="runtime-row">
          <input
            value={worktreeName}
            onChange={(e) => setWorktreeName(e.target.value)}
            placeholder="工作树名称（可留空）"
          />
          <button
            disabled={working || !session}
            onClick={() =>
              void runtime('create_worktree', worktreeName ? { name: worktreeName } : {})
            }
          >
            创建工作树
          </button>
          <button disabled={working || !session} onClick={() => void runtime('list_worktrees')}>
            列出
          </button>
        </div>
        <div className="runtime-row">
          <input
            value={worktreePath}
            onChange={(e) => setWorktreePath(e.target.value)}
            placeholder="要移除的 Bruin 工作树完整路径"
          />
          <button
            disabled={working || !session || !worktreePath.trim()}
            onClick={() => void runtime('remove_worktree', { path: worktreePath.trim() })}
          >
            移除干净的工作树
          </button>
        </div>
        <div className="runtime-row">
          <select
            value={subagentMode}
            onChange={(e) => setSubagentMode(e.target.value as 'read-only' | 'worktree')}
            aria-label="子 Agent 模式"
          >
            <option value="read-only">只读研究</option>
            <option value="worktree">独立工作树编码</option>
          </select>
          <input
            value={subagentPrompt}
            onChange={(e) => setSubagentPrompt(e.target.value)}
            placeholder="子 Agent 的任务与验收要求"
          />
          <button
            disabled={
              working ||
              !session ||
              !subagentPrompt.trim() ||
              (subagentMode === 'worktree' && !subagentEdits)
            }
            onClick={() =>
              void runtime('spawn_subagent', {
                prompt: subagentPrompt,
                mode: subagentMode,
                ...(subagentMode === 'read-only' && worktreePath.trim()
                  ? { worktree: worktreePath.trim() }
                  : {}),
              })
            }
          >
            启动子 Agent
          </button>
        </div>
        {subagentMode === 'worktree' && (
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={subagentEdits}
              onChange={(e) => setSubagentEdits(e.target.checked)}
            />
            授权子任务修改独立工作树文件；从 HEAD 开始，不含当前未提交改动，结果保留供审核
          </label>
        )}
        <div className="runtime-row">
          <input
            value={backgroundCommand}
            onChange={(e) => setBackgroundCommand(e.target.value)}
            placeholder="后台 Shell 命令"
          />
          <button
            disabled={working || !session || !backgroundCommand.trim()}
            onClick={() => void runtime('start_background', { command: backgroundCommand })}
          >
            启动后台任务
          </button>
        </div>
        <div className="runtime-row">
          <input
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            placeholder="子 Agent 或后台任务 ID"
          />
          <button
            disabled={working || !session || !taskId.trim()}
            onClick={() => void runtime('subagent_status', { id: taskId })}
          >
            子 Agent 状态
          </button>
          <button
            disabled={working || !session || !taskId.trim()}
            onClick={() => void runtime('cancel_subagent', { id: taskId })}
          >
            停止子 Agent
          </button>
          <button
            disabled={working || !session || !taskId.trim()}
            onClick={() => void runtime('background_status', { id: taskId })}
          >
            后台状态
          </button>
          <button
            disabled={working || !session || !taskId.trim()}
            onClick={() => void runtime('cancel_background', { id: taskId })}
          >
            停止后台
          </button>
        </div>
        <div className="runtime-row">
          <input
            value={subagentReviewPath}
            onChange={(e) => setSubagentReviewPath(e.target.value)}
            placeholder="子任务变更文件的相对路径"
          />
          <button
            disabled={working || !session || !taskId.trim() || !subagentReviewPath.trim()}
            onClick={() =>
              void runtime('subagent_review', { id: taskId, path: subagentReviewPath.trim() })
            }
          >
            审核子任务文件
          </button>
          <button
            disabled={working || !session || !taskId.trim()}
            onClick={() => void exportSubagentPatch()}
          >
            导出子任务补丁
          </button>
        </div>
        <h3>子任务联合预检</h3>
        <div className="runtime-row">
          <span>选择同一基线的 2 至 10 份补丁，检查能否一起应用。</span>
          <button
            disabled={working || !session}
            onClick={() => {
              setWorking(true);
              void refreshPatchCandidates()
                .catch(fail)
                .finally(() => setWorking(false));
            }}
          >
            刷新子任务
          </button>
          <button
            disabled={working || !session || selectedPatches.length < 2}
            onClick={() => void preflightPatches()}
          >
            联合预检{selectedPatches.length > 0 ? `（${selectedPatches.length}）` : ''}
          </button>
        </div>
        {patchCandidates.length ? (
          <div className="patch-candidates" role="group" aria-label="可选子任务补丁">
            {patchCandidates.map((item) => {
              const selected = selectedPatches.includes(item.id);
              return (
                <label key={item.id} className="checkbox-line">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={
                      working || item.running || (!selected && selectedPatches.length >= 10)
                    }
                    onChange={(e) =>
                      setSelectedPatches((current) =>
                        e.target.checked
                          ? [...current, item.id]
                          : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <span title={item.id}>
                    {item.prompt || item.id} · {item.id.slice(0, 8)} ·{' '}
                    {item.baseCommit.slice(0, 12)}
                    {item.running ? ' · 运行中' : ''}
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <small>当前会话暂无编码子任务。</small>
        )}
        <div className="runtime-row">
          <input
            aria-label="临时工作树测试命令"
            placeholder="测试命令，例如 npm test"
            value={patchTestCommand}
            maxLength={10_000}
            disabled={working || !session}
            onChange={(e) => setPatchTestCommand(e.target.value)}
          />
          <button
            disabled={working || !session || selectedPatches.length < 2 || !patchTestCommand.trim()}
            onClick={() => void preflightPatches(patchTestCommand)}
          >
            预检并测试
          </button>
        </div>
        {output && (
          <pre className="runtime-output" role="status">
            {output}
          </pre>
        )}
      </div>
    </Modal>
  );
}
function NewSessionDialog({
  profiles,
  defaultProfile,
  close,
  create,
  fail,
  openModels,
}: {
  profiles: Profile[];
  defaultProfile?: string;
  close: () => void;
  create: (workspace: string, alias: string) => Promise<void>;
  fail: (e: unknown) => void;
  openModels: () => void;
}) {
  const [workspace, setWorkspace] = useState('');
  const [alias, setAlias] = useState(defaultProfile ?? profiles[0]?.alias ?? '');
  const [saving, setSaving] = useState(false);
  async function pick() {
    try {
      const chosen = await api<string | null>('chooseWorkspace');
      if (chosen) setWorkspace(chosen);
    } catch (err) {
      fail(err);
    }
  }
  async function submit() {
    try {
      setSaving(true);
      await create(workspace, alias);
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="新建会话" eyebrow="START A PROJECT" close={close}>
      <div className="form-stack">
        <label>项目文件夹（可选）</label>
        <div className="field-with-button">
          <input
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder="留空则在首次创建文件时生成默认文件夹"
          />
          <button onClick={() => void pick()}>
            <FolderOpen size={17} />
          </button>
        </div>
        <label>使用模型</label>
        {profiles.length ? (
          <select value={alias} onChange={(e) => setAlias(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.alias} value={p.alias}>
                {p.alias} · {p.model}
              </option>
            ))}
          </select>
        ) : (
          <button className="text-link" onClick={openModels}>
            先添加模型 →
          </button>
        )}
        <p className="form-help">
          留空会分配一个带时间和随机名的默认工作区，首次写入文件时才创建目录。也可选择现有项目。
        </p>
        <div className="modal-actions">
          <button className="secondary" onClick={close}>
            取消
          </button>
          <button className="primary" disabled={!alias || saving} onClick={() => void submit()}>
            {saving ? '创建中…' : '创建会话'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
function AppearanceDialog({
  selected,
  uiTheme,
  close,
  changed,
  themeChanged,
  fail,
}: {
  selected: string;
  uiTheme: 'light' | 'dark';
  close: () => void;
  changed: (value: string) => void;
  themeChanged: (value: 'light' | 'dark') => void;
  fail: (error: unknown) => void;
}) {
  const [saving, setSaving] = useState(false);
  async function choose(theme: string) {
    try {
      setSaving(true);
      const result = await api<{ iconBackground: string }>('setIconBackground', { theme });
      changed(result.iconBackground);
    } catch (error) {
      fail(error);
    } finally {
      setSaving(false);
    }
  }
  async function chooseTheme(theme: 'light' | 'dark') {
    try {
      setSaving(true);
      const result = await api<{ uiTheme: 'light' | 'dark' }>('setTheme', { theme });
      themeChanged(result.uiTheme);
    } catch (error) {
      fail(error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="外观" eyebrow="BRUIN ICON" close={close}>
      <h3 className="appearance-heading">界面背景</h3>
      <div className="theme-options">
        <button
          className={uiTheme === 'light' ? 'selected' : ''}
          disabled={saving}
          onClick={() => void chooseTheme('light')}
        >
          纯白（默认）
        </button>
        <button
          className={uiTheme === 'dark' ? 'selected' : ''}
          disabled={saving}
          onClick={() => void chooseTheme('dark')}
        >
          黑色
        </button>
      </div>
      <h3 className="appearance-heading">熊图标背景</h3>
      <p className="form-help">
        选择熊图标背景色。默认纯白；更改会立即应用到 Dock 或任务栏，并在下次启动时保留。
      </p>
      <div className="icon-grid">
        {iconOptions.map((option) => (
          <button
            className={`icon-choice ${selected === option.id ? 'selected' : ''}`}
            key={option.id}
            disabled={saving}
            onClick={() => void choose(option.id)}
          >
            <img src={option.image} alt="" />
            <span>{option.label}</span>
            {selected === option.id && <Check size={16} />}
          </button>
        ))}
      </div>
    </Modal>
  );
}
function ModelDialog({
  config,
  focusAlias,
  busy,
  close,
  changed,
  fail,
}: {
  config: Config;
  focusAlias?: string;
  busy: boolean;
  close: () => void;
  changed: (c: Config) => void;
  fail: (e: unknown) => void;
}) {
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [alias, setAlias] = useState('');
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [contextWindowTokens, setContextWindowTokens] = useState('32768');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingAlias, setDeletingAlias] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  function reset() {
    setEditingAlias(null);
    setAlias('');
    setProvider('openai');
    setModel('');
    setBaseUrl('');
    setApiKeyEnv('');
    setContextWindowTokens('32768');
    setApiKey('');
    setClearApiKey(false);
  }
  function edit(profile: Profile) {
    setEditingAlias(profile.alias);
    setAlias(profile.alias);
    setProvider(profile.provider);
    setModel(profile.model);
    setBaseUrl(profile.baseUrl ?? '');
    setApiKeyEnv(profile.apiKeyEnv ?? '');
    setContextWindowTokens(String(profile.contextWindowTokens ?? 32768));
    setApiKey('');
    setClearApiKey(false);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  useEffect(() => {
    const profile = config.profiles.find((item) => item.alias === focusAlias);
    if (profile) edit(profile);
  }, [focusAlias]);
  async function save() {
    const contextTokens = Number(contextWindowTokens);
    if (!Number.isInteger(contextTokens) || contextTokens < 8192 || contextTokens > 1_048_576) {
      fail(new Error('上下文窗口须为 8192 到 1048576 之间的整数'));
      return;
    }
    if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      fail(new Error('环境变量名只能包含字母、数字和下划线；密钥值请填入 API Key 输入框'));
      return;
    }
    try {
      setSaving(true);
      changed(
        await api<Config>('saveProfile', {
          alias,
          provider,
          model,
          baseUrl,
          apiKeyEnv,
          contextWindowTokens: contextTokens,
          apiKey,
          clearApiKey,
        }),
      );
      reset();
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  }
  async function setDefault(value: string) {
    try {
      changed(await api<Config>('setDefaultModel', { alias: value }));
    } catch (err) {
      fail(err);
    }
  }
  async function removeProfile(value: string) {
    try {
      changed(await api<Config>('removeProfile', { alias: value }));
      if (editingAlias === value) reset();
      setDeletingAlias(null);
    } catch (err) {
      fail(err);
    }
  }
  return (
    <Modal title="模型设置" eyebrow="MODEL PROVIDERS" close={close}>
      <div className="settings-list">
        {config.profiles.map((p) => (
          <div className="profile-row" key={p.alias}>
            <div className="profile-icon">
              <Bot size={18} />
            </div>
            <div>
              <strong>{p.alias}</strong>
              <small>
                {p.provider} · {p.model} · 上下文 {p.contextWindowTokens ?? 32768} tokens
              </small>
            </div>
            {config.defaultProfile === p.alias ? (
              <span className="default-tag">默认</span>
            ) : (
              <button
                className="subtle-button"
                disabled={busy}
                onClick={() => void setDefault(p.alias)}
              >
                设为默认
              </button>
            )}
            <button className="subtle-button" disabled={busy} onClick={() => edit(p)}>
              编辑
            </button>
            <button
              className="subtle-button"
              disabled={busy}
              title={deletingAlias === p.alias ? '再次点击，删除本地模型配置' : '删除本地模型配置'}
              onClick={() =>
                deletingAlias === p.alias ? void removeProfile(p.alias) : setDeletingAlias(p.alias)
              }
            >
              {deletingAlias === p.alias ? '确认删除' : '删除'}
            </button>
          </div>
        ))}
        {!config.profiles.length && (
          <div className="settings-empty">尚未配置模型。添加后即可创建会话。</div>
        )}
      </div>
      <div className="divider" />
      <div className="form-stack" ref={formRef}>
        <div className="form-heading">
          <h3>{editingAlias ? `编辑 ${editingAlias}` : '添加模型'}</h3>
          {editingAlias && (
            <button className="subtle-button" onClick={reset}>
              取消编辑
            </button>
          )}
        </div>
        <div className="two-col">
          <div>
            <label>别名</label>
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="例如 main"
              disabled={Boolean(editingAlias)}
            />
          </div>
          <div>
            <label>服务商</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini</option>
              <option value="openai-compatible">OpenAI 兼容接口</option>
            </select>
          </div>
        </div>
        <label>模型 ID</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="例如 gpt-4.1"
        />
        <label>上下文窗口（tokens）</label>
        <input
          type="range"
          min="8192"
          max="1048576"
          step="8192"
          value={contextWindowTokens}
          onChange={(e) => setContextWindowTokens(e.target.value)}
          aria-label="上下文窗口滑块"
        />
        <input
          type="number"
          min="8192"
          max="1048576"
          step="1"
          value={contextWindowTokens}
          onChange={(e) => setContextWindowTokens(e.target.value)}
        />
        <p className="form-help">
          上限 1,048,576 tokens。请按模型实际支持的窗口设置；预留四分之一给回复及工具。
        </p>
        <label>Base URL {provider === 'openai-compatible' ? '' : '（可选）'}</label>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
        />
        <label>API Key（可选，直接粘贴密钥）</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setClearApiKey(false);
          }}
          placeholder={editingAlias ? '留空则保留已保存的密钥' : '保存在系统安全存储中'}
        />
        {editingAlias && (
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={clearApiKey}
              onChange={(e) => {
                setClearApiKey(e.target.checked);
                if (e.target.checked) setApiKey('');
              }}
            />{' '}
            清除已保存的密钥，改用环境变量
          </label>
        )}
        <details className="model-advanced" open={Boolean(apiKeyEnv)}>
          <summary>高级：从环境变量读取密钥</summary>
          <label>环境变量名称（不是密钥值）</label>
          <input
            value={apiKeyEnv}
            onChange={(e) => setApiKeyEnv(e.target.value)}
            placeholder="例如 OPENAI_API_KEY"
          />
          <p className="form-help">只填变量名。请在启动 Bruin 的环境中设置该变量。</p>
        </details>
        <p className="form-help">
          直接输入的 API Key 使用系统安全存储加密，不写入配置或会话数据库；也可使用环境变量。
        </p>
        <div className="modal-actions">
          <button className="secondary" onClick={close}>
            完成
          </button>
          <button
            className="primary"
            disabled={
              !alias || !model || saving || busy || (provider === 'openai-compatible' && !baseUrl)
            }
            onClick={() => void save()}
          >
            {saving ? '保存中…' : editingAlias ? '保存修改' : '添加模型'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
function SkillsDialog({
  skills,
  markets,
  close,
  changed,
  marketsChanged,
  fail,
}: {
  skills: Skill[];
  markets: Market[];
  close: () => void;
  changed: (s: Skill[]) => void;
  marketsChanged: (m: Market[]) => void;
  fail: (e: unknown) => void;
}) {
  const [tab, setTab] = useState<'installed' | 'github' | 'market'>('installed');
  const [selected, setSelected] = useState<Skill | null>(null);
  const [content, setContent] = useState('');
  const [repo, setRepo] = useState('');
  const [subdir, setSubdir] = useState('');
  const [ref, setRef] = useState('HEAD');
  const [local, setLocal] = useState('');
  const [marketName, setMarketName] = useState(markets[0]?.name ?? '');
  const [newMarket, setNewMarket] = useState('');
  const [newMarketRepo, setNewMarketRepo] = useState('');
  const [entries, setEntries] = useState<MarketEntry[]>([]);
  const [working, setWorking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  async function act<T>(
    method: string,
    params: Record<string, unknown>,
    onSuccess: (value: T) => void,
  ) {
    try {
      setWorking(true);
      onSuccess(await api<T>(method, params));
    } catch (err) {
      fail(err);
    } finally {
      setWorking(false);
    }
  }
  async function show(skill: Skill) {
    setSelected(skill);
    setConfirmRemove(null);
    try {
      setContent(await api<string>('readSkill', { name: skill.name }));
    } catch (err) {
      fail(err);
    }
  }
  return (
    <Modal title="Skills" eyebrow="EXTEND BRUIN" close={close}>
      <div className="tabs">
        <button
          className={tab === 'installed' ? 'selected' : ''}
          onClick={() => setTab('installed')}
        >
          已安装 ({skills.length})
        </button>
        <button className={tab === 'github' ? 'selected' : ''} onClick={() => setTab('github')}>
          GitHub / 本地
        </button>
        <button className={tab === 'market' ? 'selected' : ''} onClick={() => setTab('market')}>
          市场
        </button>
      </div>
      {tab === 'installed' && (
        <div className="settings-list skills-list">
          {skills.map((skill) => (
            <div className="skill-row" key={skill.name}>
              <div className="skill-icon">
                <Layers size={17} />
              </div>
              <button type="button" className="skill-copy" onClick={() => void show(skill)}>
                <strong>{skill.name}</strong>
                <small>{skill.description}</small>
                <em>{skill.source.startsWith('builtin:') ? 'Bruin 内置' : skill.source}</em>
              </button>
              <button
                className={`toggle ${skill.enabled ? 'on' : ''}`}
                aria-label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`}
                disabled={working}
                onClick={() =>
                  void act<Skill[]>(
                    'setSkillEnabled',
                    { name: skill.name, enabled: !skill.enabled },
                    changed,
                  )
                }
              >
                <span />
              </button>
            </div>
          ))}
          {!skills.length && (
            <div className="settings-empty">
              还没有安装 Skill。可从 GitHub、本地文件夹或市场添加。
            </div>
          )}
          {selected && (
            <div className="skill-preview">
              <div>
                <strong>{selected.name} / SKILL.md</strong>
                <button
                  onClick={() => {
                    setSelected(null);
                    setContent('');
                  }}
                >
                  <X size={14} />
                </button>
              </div>
              <pre>{content}</pre>
              <div>
                {!selected.source.startsWith('builtin:') && (
                  <button
                    className="subtle-button"
                    onClick={() =>
                      void act<Skill[]>('updateSkill', { name: selected.name }, (value) => {
                        changed(value);
                        setSelected(null);
                      })
                    }
                  >
                    更新
                  </button>
                )}
                {!selected.source.startsWith('builtin:') &&
                  (confirmRemove === selected.name ? (
                    <>
                      <button
                        className="subtle-button"
                        disabled={working}
                        onClick={() => setConfirmRemove(null)}
                      >
                        取消
                      </button>
                      <button
                        className="danger-text"
                        disabled={working}
                        onClick={() =>
                          void act<Skill[]>('removeSkill', { name: selected.name }, (value) => {
                            changed(value);
                            setSelected(null);
                            setConfirmRemove(null);
                          })
                        }
                      >
                        确认卸载
                      </button>
                    </>
                  ) : (
                    <button
                      className="danger-text"
                      disabled={working}
                      onClick={() => setConfirmRemove(selected.name)}
                    >
                      卸载
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
      {tab === 'github' && (
        <div className="form-stack">
          <h3>从 GitHub 安装</h3>
          <label>仓库</label>
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
          <div className="two-col">
            <div>
              <label>Skill 子目录</label>
              <input
                value={subdir}
                onChange={(e) => setSubdir(e.target.value)}
                placeholder="skills/my-skill"
              />
            </div>
            <div>
              <label>分支 / Commit</label>
              <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="HEAD" />
            </div>
          </div>
          <button
            className="primary form-button"
            disabled={!repo || !subdir || working}
            onClick={() =>
              void act<Skill[]>('installGithub', { repo, subdir, ref }, (value) => {
                changed(value);
                setTab('installed');
              })
            }
          >
            安装 GitHub Skill
          </button>
          <div className="divider" />
          <h3>从本地安装</h3>
          <label>Skill 目录</label>
          <input
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            placeholder="/path/to/skill"
          />
          <button
            className="secondary form-button"
            disabled={!local || working}
            onClick={() =>
              void act<Skill[]>('installLocal', { directory: local }, (value) => {
                changed(value);
                setTab('installed');
              })
            }
          >
            安装本地 Skill
          </button>
          <p className="form-help">远程 Skill 安装后默认停用。阅读内容后再启用。</p>
        </div>
      )}
      {tab === 'market' && (
        <div className="form-stack">
          <h3>自建 GitHub 市场</h3>
          <div className="two-col">
            <input
              value={newMarket}
              onChange={(e) => setNewMarket(e.target.value)}
              placeholder="市场名称"
            />
            <input
              value={newMarketRepo}
              onChange={(e) => setNewMarketRepo(e.target.value)}
              placeholder="owner/repo"
            />
          </div>
          <button
            className="secondary form-button"
            disabled={!newMarket || !newMarketRepo || working}
            onClick={() =>
              void act<Market[]>('addMarket', { name: newMarket, repo: newMarketRepo }, (value) => {
                marketsChanged(value);
                setMarketName(newMarket);
              })
            }
          >
            添加市场
          </button>
          <div className="divider" />
          <h3>浏览市场</h3>
          <div className="field-with-button">
            <select value={marketName} onChange={(e) => setMarketName(e.target.value)}>
              <option value="">选择市场</option>
              {markets.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              disabled={!marketName || working}
              onClick={() =>
                void act<MarketEntry[]>('marketEntries', { name: marketName }, setEntries)
              }
            >
              浏览
            </button>
          </div>
          {entries.map((entry) => (
            <div className="market-entry" key={entry.name}>
              <div>
                <strong>{entry.name}</strong>
                <small>{entry.description}</small>
              </div>
              <button
                disabled={working}
                onClick={() =>
                  void act<Skill[]>(
                    'installFromMarket',
                    { market: marketName, skill: entry.name },
                    (value) => {
                      changed(value);
                      setTab('installed');
                    },
                  )
                }
              >
                安装
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
