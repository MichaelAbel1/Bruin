import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Code2,
  FileText,
  Folder,
  FolderOpen,
  Layers,
  LoaderCircle,
  Menu,
  MessageSquare,
  Paperclip,
  Plus,
  Palette,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import './style.css';
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
};
type Session = {
  id: string;
  workspace: string;
  managedWorkspace?: boolean;
  profile: Profile;
  createdAt: string;
  updatedAt: string;
};
type SessionEvent = { seq: number; type: string; at: string; payload: Record<string, unknown> };
type SessionView = {
  session: Session;
  events: SessionEvent[];
  plan: { enabled: boolean; steps: string[]; approved: boolean; progress: Record<number, string> };
  needsReview: boolean;
  recoveredUnknown?: number;
  tasks?: TaskNode[];
};
type CronJob = {
  id: string;
  expression: string;
  prompt: string;
  nextRunAt: number;
  lastStatus?: string;
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
  approvalId: string;
  call: { name: string; input: Record<string, unknown> };
  reason: string;
};
type McpServer =
  | { name: string; transport: 'stdio'; command: string; args: string[]; envNames: string[] }
  | { name: string; transport: 'http'; url: string; tokenEnv?: string };
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
};
type HostEvent = {
  type: string;
  sessionId?: string;
  delta?: string;
  message?: string;
  events?: SessionEvent[];
  approvalId?: string;
  call?: Approval['call'];
  reason?: string;
};
type WorkspaceEntry = { name: string; path: string; kind: 'file' | 'directory' };
type OpenFile = { path: string; content: string; truncated: boolean };
type AttachmentRef = {
  id: string;
  name: string;
  kind: 'image' | 'document' | 'file';
  note?: string;
};
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
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="message-text markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href?.startsWith('https://') ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
function sessionTitle(session: Session, events?: SessionEvent[]) {
  const user = events?.find((e) => e.type === 'user');
  const label = typeof user?.payload.text === 'string' ? user.payload.text : '';
  return label ? label.slice(0, 36) : short(session.workspace);
}
function App() {
  const [config, setConfig] = useState<Config>({
    profiles: [],
    marketplaces: [],
    mcpServers: [],
    hooks: [],
  });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [view, setView] = useState<SessionView | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [quote, setQuote] = useState<{ seq: number; text: string } | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [dialog, setDialog] = useState<
    'model' | 'new' | 'skills' | 'appearance' | 'runtime' | 'preferences' | null
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
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelDiscoveryError, setModelDiscoveryError] = useState('');
  const [modelLoading, setModelLoading] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);
  const [deletingSession, setDeletingSession] = useState<string | null>(null);
  const selected = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const fail = (err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
    window.setTimeout(() => setError(''), 6500);
  };
  async function refreshSessions() {
    setSessions(await api<Session[]>('listSessions'));
  }
  async function deleteSession(id: string) {
    try {
      const remaining = await api<Session[]>('deleteSession', { sessionId: id });
      setSessions(remaining);
      setDeletingSession(null);
      if (selected.current === id) {
        selected.current = null;
        setView(null);
        if (remaining[0]) await openSession(remaining[0].id);
      }
    } catch (err) {
      fail(err);
    }
  }
  async function openSession(id: string) {
    try {
      const result = await api<SessionView>('openSession', { sessionId: id });
      selected.current = id;
      setView(result);
      setOpenFiles([]);
      setActiveFile(null);
      setAttachments([]);
      setQuote(null);
      setStream('');
      setSidebarOpen(false);
      if (result.recoveredUnknown)
        setNotice(`已发现 ${result.recoveredUnknown} 个结果未知的工具调用，请检查工作区。`);
    } catch (err) {
      fail(err);
    }
  }
  async function openFile(path: string) {
    if (!view) return;
    try {
      const file = await api<OpenFile>('readWorkspaceFile', { sessionId: view.session.id, path });
      setOpenFiles((current) => [...current.filter((item) => item.path !== path), file]);
      setActiveFile(path);
    } catch (err) {
      fail(err);
    }
  }
  async function changeWorkspace() {
    if (!view || busy) return;
    try {
      const workspace = await api<string | null>('chooseWorkspace');
      if (!workspace) return;
      const next = await api<SessionView>('setWorkspace', {
        sessionId: view.session.id,
        workspace,
      });
      setView(next);
      setOpenFiles([]);
      setActiveFile(null);
      setAttachments([]);
      setQuote(null);
      await refreshSessions();
    } catch (err) {
      fail(err);
    }
  }
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
        setBusy(Boolean(data.busySessionId));
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
        setBusy(false);
        return;
      }
      if (message.type === 'approval' && message.approvalId && message.call && message.sessionId) {
        setApproval({
          approvalId: message.approvalId,
          call: message.call,
          sessionId: message.sessionId,
          reason: message.reason ?? '',
        });
        return;
      }
      if (message.sessionId !== selected.current) return;
      if (message.type === 'runStarted') {
        setBusy(true);
        setNotice('');
      }
      if (message.type === 'text') setStream((previous) => previous + (message.delta ?? ''));
      if (message.type === 'notice') setNotice(message.message ?? '');
      if (message.type === 'runFinished' || message.type === 'runFailed') {
        setBusy(false);
        setStream('');
        setApproval(null);
        if (message.events)
          setView((previous) =>
            previous
              ? {
                  ...previous,
                  events: message.events!,
                  needsReview: message.events!.some(
                    (e) =>
                      e.type === 'tool_unknown' &&
                      e.seq >
                        (message.events!.filter((x) => x.type === 'turn_completed').at(-1)?.seq ??
                          0),
                  ),
                }
              : previous,
          );
        void refreshSessions().catch(fail);
        if (message.sessionId)
          void api<SessionView>('openSession', { sessionId: message.sessionId })
            .then((next) => {
              if (selected.current === message.sessionId) setView(next);
            })
            .catch(fail);
        if (message.type === 'runFailed') fail(new Error(message.message ?? '执行失败'));
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme;
  }, [uiTheme]);
  useEffect(() => {
    const alias = view?.session.profile.alias;
    if (!alias) {
      setDiscoveredModels([]);
      return;
    }
    let cancelled = false;
    setModelLoading(true);
    setDiscoveredModels([]);
    setModelDiscoveryError('');
    void api<string[]>('discoverModels', { alias, refresh: modelRefresh > 0 })
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
  }, [view?.session.profile.alias, config, modelRefresh]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [view?.events.length, stream, notice, approval]);

  async function send() {
    if (!view || (!composer.trim() && !attachments.length && !quote) || busy || view.needsReview)
      return;
    const text = composer.trim();
    const submittedAttachments = attachments;
    const submittedQuote = quote;
    setComposer('');
    setAttachments([]);
    setQuote(null);
    setBusy(true);
    setView((previous) =>
      previous
        ? {
            ...previous,
            events: [
              ...previous.events,
              {
                seq: -Date.now(),
                type: 'user',
                at: new Date().toISOString(),
                payload: { text, attachments: submittedAttachments, quote: submittedQuote },
              },
            ],
          }
        : previous,
    );
    try {
      await api('send', {
        sessionId: view.session.id,
        prompt: text,
        attachments: submittedAttachments.map((item) => item.id),
        quoteSeq: submittedQuote?.seq,
      });
    } catch (err) {
      setBusy(false);
      await openSession(view.session.id);
      setComposer(text);
      setAttachments(submittedAttachments);
      setQuote(submittedQuote);
      fail(err);
    }
  }
  async function chooseAttachments(kind: 'file' | 'folder') {
    if (!view) return;
    try {
      const selected = await api<AttachmentRef[]>('chooseAttachments', {
        sessionId: view.session.id,
        kind,
      });
      setAttachments((current) => [...current, ...selected].slice(0, 30));
    } catch (err) {
      fail(err);
    }
  }
  async function cancel() {
    if (view)
      try {
        await api('cancel', { sessionId: view.session.id });
      } catch (err) {
        fail(err);
      }
  }
  async function decide(approved: boolean) {
    if (!approval) return;
    try {
      await api('answerApproval', { approvalId: approval.approvalId, approved });
      setApproval(null);
    } catch (err) {
      fail(err);
    }
  }
  async function switchModel(modelId: string) {
    if (!view) return;
    try {
      setView(
        await api<SessionView>('setSessionModel', {
          sessionId: view.session.id,
          alias: view.session.profile.alias,
          modelId,
        }),
      );
      await refreshSessions();
    } catch (err) {
      fail(err);
    }
  }
  async function resume() {
    if (!view || busy || view.needsReview) return;
    try {
      setBusy(true);
      await api('resume', { sessionId: view.session.id });
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  }
  async function acknowledge() {
    if (!view) return;
    try {
      setView(await api<SessionView>('reviewUnknown', { sessionId: view.session.id }));
      setNotice('已确认检查工作区。可继续会话。');
    } catch (err) {
      fail(err);
    }
  }
  async function planAction(method: string, params: Record<string, unknown>) {
    if (!view) return;
    try {
      setView(await api<SessionView>(method, { sessionId: view.session.id, ...params }));
    } catch (err) {
      fail(err);
    }
  }
  const lastEvent = view?.events.at(-1);
  const canResume = Boolean(
    view &&
    view.events.some((e) => e.type === 'user') &&
    lastEvent?.type !== 'turn_completed' &&
    !busy,
  );

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <Code2 size={21} strokeWidth={2.4} />
          </div>
          <span>Bruin</span>
          <span className="brand-beta">DESKTOP</span>
        </div>
        <button
          className="new-task"
          onClick={() => {
            setDialog('new');
            setSidebarOpen(false);
          }}
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
                disabled={busy && view?.session.id !== session.id}
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
                disabled={busy && view?.session.id === session.id}
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
      <main className="main-area">
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
              <>
                <button
                  className="workspace-path workspace-switch"
                  title="更换此会话的项目文件夹"
                  disabled={busy}
                  onClick={() => void changeWorkspace()}
                >
                  <FolderOpen size={14} />
                  {view.session.workspace}
                </button>
                <select
                  className="model-select model-id-select"
                  aria-label="当前模型 ID"
                  title={
                    modelDiscoveryError ||
                    (modelLoading ? '正在获取模型列表' : '选择当前 API 提供的模型')
                  }
                  value={view.session.profile.model}
                  onChange={(e) => void switchModel(e.target.value)}
                  disabled={busy || modelLoading}
                >
                  {[...new Set([view.session.profile.model, ...discoveredModels])].map((id) => (
                    <option value={id} key={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button model-refresh"
                  aria-label="刷新可用模型"
                  title={modelDiscoveryError || '刷新可用模型'}
                  disabled={busy || modelLoading}
                  onClick={() => setModelRefresh((value) => value + 1)}
                >
                  <LoaderCircle size={15} className={modelLoading ? 'spinning' : ''} />
                </button>
                {modelDiscoveryError &&
                  (modelDiscoveryError.includes('缺少 API Key') ? (
                    <button
                      className="model-catalog-error model-key-action"
                      onClick={() => setDialog('model')}
                    >
                      添加 API Key
                    </button>
                  ) : (
                    <span className="model-catalog-error" title={modelDiscoveryError}>
                      模型列表不可用
                    </span>
                  ))}
              </>
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
            <button className={!activeFile ? 'active' : ''} onClick={() => setActiveFile(null)}>
              <MessageSquare size={14} /> 对话
            </button>
            {openFiles.map((file) => (
              <div
                className={`editor-tab ${activeFile === file.path ? 'active' : ''}`}
                key={file.path}
              >
                <button title={file.path} onClick={() => setActiveFile(file.path)}>
                  <FileText size={14} /> {short(file.path)}
                </button>
                <button
                  aria-label={`关闭 ${file.path}`}
                  onClick={() => {
                    setOpenFiles((current) => current.filter((item) => item.path !== file.path));
                    if (activeFile === file.path) setActiveFile(null);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
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
            <button
              className="primary"
              onClick={() => setDialog(config.profiles.length ? 'new' : 'model')}
            >
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
        ) : activeFile ? (
          <div className="inline-file-viewer">
            <div className="file-viewer-heading">
              <FileText size={18} />
              <strong>{activeFile}</strong>
              <span>只读预览</span>
            </div>
            {openFiles.find((file) => file.path === activeFile)?.truncated && (
              <p>文件过大，仅显示前 256 KB。</p>
            )}
            <pre>{openFiles.find((file) => file.path === activeFile)?.content ?? ''}</pre>
          </div>
        ) : (
          <>
            <div className="conversation" key={view.session.id}>
              <div className="conversation-intro">
                <div className="project-monogram">
                  {short(view.session.workspace).slice(0, 1).toUpperCase()}
                </div>
                <h1>{short(view.session.workspace)}</h1>
                <p>{view.session.workspace}</p>
                <span>
                  模型 {view.session.profile.alias} · 会话 {view.session.id.slice(0, 8)}
                </span>
              </div>
              {view.needsReview && (
                <div className="review-banner">
                  <CircleAlert size={19} />
                  <div>
                    <strong>有工具操作的结果未知</strong>
                    <p>上次运行可能在工具执行中中断。请检查项目文件，再继续执行。</p>
                  </div>
                  <button onClick={() => void acknowledge()}>我已检查</button>
                </div>
              )}
              <div className="plan-panel">
                <div className="plan-heading">
                  <strong>规划模式</strong>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void planAction('setPlanMode', { enabled: !view.plan.enabled })}
                  >
                    {view.plan.enabled ? '关闭' : '开启'}
                  </button>
                </div>
                {view.plan.enabled && (
                  <>
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
                      <p>请让 Bruin 先生成计划；批准前只能使用只读工具。</p>
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
                    {view.plan.approved && <small>计划已批准。修改仍遵循逐项工具审批。</small>}
                  </>
                )}
              </div>
              {view.events
                .filter((e) =>
                  [
                    'user',
                    'assistant',
                    'tool_finished',
                    'tool_denied',
                    'tool_unknown',
                    'model_error',
                  ].includes(e.type),
                )
                .map((e) => (
                  <EventCard
                    key={e.seq}
                    event={e}
                    onQuote={(selected) =>
                      setQuote({
                        seq: selected.seq,
                        text: String(selected.payload.text ?? '').slice(0, 4000),
                      })
                    }
                  />
                ))}
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
              {busy && !stream && (
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
                <button className="resume-button" onClick={() => void resume()}>
                  <Sparkles size={16} /> 继续未完成的运行
                </button>
              )}
              <div ref={bottom} />
            </div>
            <div className="composer-wrap">
              <div className="composer">
                {(quote || attachments.length > 0) && (
                  <div className="composer-context">
                    {quote && (
                      <span className="composer-chip">
                        <MessageSquare size={13} /> 引用：{quote.text.slice(0, 60) || '消息'}
                        <button aria-label="移除引用" onClick={() => setQuote(null)}>
                          <X size={13} />
                        </button>
                      </span>
                    )}
                    {attachments.map((item) => (
                      <span className="composer-chip" key={item.id} title={item.note}>
                        <Paperclip size={13} />
                        {item.name}
                        {item.note ? ' · 无法提取内容' : ''}
                        <button
                          aria-label={`移除 ${item.name}`}
                          onClick={() =>
                            setAttachments((current) =>
                              current.filter((file) => file.id !== item.id),
                            )
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
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={
                    view.needsReview ? '请先检查并确认未知的工具操作' : '给 Bruin 一个任务…'
                  }
                  disabled={view.needsReview}
                />
                <div className="composer-bottom">
                  <span className="composer-tools">
                    <button
                      type="button"
                      title="添加图片、文档或文件"
                      aria-label="添加文件"
                      disabled={busy}
                      onClick={() => void chooseAttachments('file')}
                    >
                      <Paperclip size={16} />
                    </button>
                    <button
                      type="button"
                      title="添加文件夹"
                      aria-label="添加文件夹"
                      disabled={busy}
                      onClick={() => void chooseAttachments('folder')}
                    >
                      <FolderOpen size={16} />
                    </button>
                    <Sparkles size={14} /> {view.session.profile.model}{' '}
                    <span className="composer-hint">· ⌘/Ctrl + Enter 发送</span>
                  </span>
                  {busy ? (
                    <button
                      className="send-button stop"
                      title="停止运行"
                      onClick={() => void cancel()}
                    >
                      <Square size={16} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      title="发送"
                      disabled={
                        (!composer.trim() && !attachments.length && !quote) || view.needsReview
                      }
                      onClick={() => void send()}
                    >
                      <Send size={17} />
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-disclaimer">Bruin 可能出错。应用修改前请检查结果。</div>
            </div>
          </>
        )}
      </main>
      {error && (
        <div className="toast error">
          <CircleAlert size={16} />
          {error}
          <button onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
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
            <p>{approval.reason}</p>
            <div className="approval-name">
              <Terminal size={15} />
              {approval.call.name}
            </div>
            <pre>{JSON.stringify(approval.call.input, null, 2)}</pre>
            <div className="modal-actions">
              <button className="secondary" onClick={() => void decide(false)}>
                拒绝
              </button>
              <button className="primary" onClick={() => void decide(true)}>
                <Check size={16} /> 允许本次操作
              </button>
            </div>
          </div>
        </div>
      )}
      {dialog === 'new' && (
        <NewSessionDialog
          profiles={config.profiles}
          defaultProfile={config.defaultProfile}
          close={() => setDialog(null)}
          created={(result) => {
            setDialog(null);
            setSessions((previous) => [result.session, ...previous]);
            selected.current = result.session.id;
            setView(result);
            setOpenFiles([]);
            setActiveFile(null);
          }}
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
            if (view && !busy)
              void api<SessionView>('openSession', { sessionId: view.session.id })
                .then(setView)
                .catch(fail);
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
          config={config}
          session={view?.session}
          close={() => setDialog(null)}
          changed={setConfig}
          fail={fail}
        />
      )}
      {dialog === 'preferences' && <PreferencesDialog close={() => setDialog(null)} fail={fail} />}
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
      .catch(fail)
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

function EventCard({
  event,
  onQuote,
}: {
  event: SessionEvent;
  onQuote: (event: SessionEvent) => void;
}) {
  if (event.type === 'user')
    return (
      <div className="message user">
        <div className="message-icon">你</div>
        <div className="message-body">
          <div className="message-author">
            你 <time>{date(event.at)}</time>
          </div>
          <MarkdownMessage text={String(event.payload.text ?? '')} />
          {Boolean(event.payload.quote) && (
            <div className="message-quote">
              引用：{String((event.payload.quote as { text?: string }).text ?? '').slice(0, 160)}
            </div>
          )}
          {Array.isArray(event.payload.attachments) && (
            <div className="message-attachments">
              {(event.payload.attachments as AttachmentRef[]).map((item) => (
                <span key={item.id}>
                  <Paperclip size={13} />
                  {item.name}
                </span>
              ))}
            </div>
          )}
          {event.seq > 0 && (
            <button className="quote-action" onClick={() => onQuote(event)}>
              引用
            </button>
          )}
        </div>
      </div>
    );
  if (event.type === 'assistant') {
    const text = String(event.payload.text ?? '');
    const calls = Array.isArray(event.payload.calls)
      ? (event.payload.calls as Array<{ name: string }>)
      : [];
    if (!text && !calls.length) return null;
    return (
      <div className="message assistant">
        <div className="message-icon">
          <Bot size={17} />
        </div>
        <div className="message-body">
          <div className="message-author">
            Bruin <time>{date(event.at)}</time>
          </div>
          {text && <MarkdownMessage text={text} />}
          {text && event.seq > 0 && (
            <button className="quote-action" onClick={() => onQuote(event)}>
              引用
            </button>
          )}
          {calls.length > 0 && (
            <div className="tool-chips">
              {calls.map((call, index) => (
                <span key={index}>
                  <Terminal size={13} />
                  {call.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (event.type === 'model_error')
    return (
      <div className="event-error">
        <CircleAlert size={15} />
        {String(event.payload.message ?? '模型请求失败')}
      </div>
    );
  const label =
    event.type === 'tool_finished'
      ? event.payload.isError
        ? '工具失败'
        : '工具完成'
      : event.type === 'tool_denied'
        ? '工具已拒绝'
        : '工具结果未知';
  return (
    <details className={`tool-result ${event.type}`}>
      <summary>
        <Terminal size={15} />
        <strong>{String(event.payload.name ?? '工具')}</strong>
        <span>{label}</span>
        <ChevronDown size={14} />
      </summary>
      <pre>{String(event.payload.output ?? '')}</pre>
    </details>
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
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal">
        <div className="modal-top">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={close}>
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function RuntimeDialog({
  config,
  session,
  close,
  changed,
  fail,
}: {
  config: Config;
  session?: Session;
  close: () => void;
  changed: (next: Config) => void;
  fail: (error: unknown) => void;
}) {
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [serverName, setServerName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [args, setArgs] = useState('');
  const [envName, setEnvName] = useState('');
  const [hookName, setHookName] = useState('');
  const [hookEvent, setHookEvent] = useState<Hook['event']>('before_tool');
  const [hookCommand, setHookCommand] = useState('');
  const [worktreeName, setWorktreeName] = useState('');
  const [worktreePath, setWorktreePath] = useState('');
  const [subagentPrompt, setSubagentPrompt] = useState('');
  const [backgroundCommand, setBackgroundCommand] = useState('');
  const [taskId, setTaskId] = useState('');
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [cronPrompt, setCronPrompt] = useState('');
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskDependencies, setTaskDependencies] = useState('');
  const [graphTaskId, setGraphTaskId] = useState('');
  const [graphTasks, setGraphTasks] = useState<TaskNode[]>([]);
  const [retryConfirmId, setRetryConfirmId] = useState('');
  const [memoryKey, setMemoryKey] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  useEffect(() => {
    if (!session) return;
    void api<CronJob[]>('listCronJobs', { sessionId: session.id }).then(setCronJobs).catch(fail);
    void api<TaskNode[]>('listTasks', { sessionId: session.id }).then(setGraphTasks).catch(fail);
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
      const result = await api<{ output: string }>('runtimeTool', {
        sessionId: session.id,
        name,
        input,
      });
      setOutput(result.output);
      if (name.endsWith('_task') || name === 'list_tasks')
        setGraphTasks(await api<TaskNode[]>('listTasks', { sessionId: session.id }));
    } catch (error) {
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
      });
      setCronJobs(await api<CronJob[]>('listCronJobs', { sessionId: session.id }));
      setCronPrompt('');
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
        <h3>MCP 服务器</h3>
        {config.mcpServers.map((server) => (
          <div className="runtime-row" key={server.name}>
            <span>
              <strong>{server.name}</strong> ·{' '}
              {server.transport === 'stdio' ? server.command : server.url}
            </span>
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
                    ...(envName.trim() ? { tokenEnv: envName.trim() } : {}),
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
        <button
          className="secondary"
          disabled={working || !session || !cronPrompt.trim()}
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
          <input
            value={subagentPrompt}
            onChange={(e) => setSubagentPrompt(e.target.value)}
            placeholder="只读子 Agent 任务"
          />
          <button
            disabled={working || !session || !subagentPrompt.trim()}
            onClick={() =>
              void runtime('spawn_subagent', {
                prompt: subagentPrompt,
                ...(worktreePath.trim() ? { worktree: worktreePath.trim() } : {}),
              })
            }
          >
            启动子 Agent
          </button>
        </div>
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
        {output && <pre className="runtime-output">{output}</pre>}
      </div>
    </Modal>
  );
}
function NewSessionDialog({
  profiles,
  defaultProfile,
  close,
  created,
  fail,
  openModels,
}: {
  profiles: Profile[];
  defaultProfile?: string;
  close: () => void;
  created: (result: SessionView) => void;
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
  async function create() {
    try {
      setSaving(true);
      created(await api<SessionView>('createSession', { workspace, profileAlias: alias }));
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
          <button className="primary" disabled={!alias || saving} onClick={() => void create()}>
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
    setApiKey('');
    setClearApiKey(false);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  useEffect(() => {
    const profile = config.profiles.find((item) => item.alias === focusAlias);
    if (profile) edit(profile);
  }, [focusAlias]);
  async function save() {
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
                {p.provider} · {p.model}
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
              <div className="skill-copy" onClick={() => void show(skill)}>
                <strong>{skill.name}</strong>
                <small>{skill.description}</small>
                <em>{skill.source.startsWith('builtin:') ? 'Bruin 内置' : skill.source}</em>
              </div>
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
                {!selected.source.startsWith('builtin:') && (
                  <button
                    className="danger-text"
                    onClick={() => {
                      if (window.confirm(`卸载 ${selected.name}？`))
                        void act<Skill[]>('removeSkill', { name: selected.name }, (value) => {
                          changed(value);
                          setSelected(null);
                        });
                    }}
                  >
                    卸载
                  </button>
                )}
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
