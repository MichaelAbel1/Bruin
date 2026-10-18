import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, Check, ChevronDown, CircleAlert, Paperclip, Sparkles, Terminal } from 'lucide-react';
import type { AttachmentRef } from '../../../../src/core/attachments.js';
import type { SessionEvent } from './events.js';
import { date } from '../formatting.js';

export function MarkdownMessage({ text }: { text: string }) {
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

export function ToolActivity({ events }: { events: SessionEvent[] }) {
  const results = events.filter((event) =>
    ['tool_finished', 'tool_denied', 'tool_unknown'].includes(event.type),
  );
  const pending =
    events.flatMap((event) =>
      event.type === 'assistant' && Array.isArray(event.payload.calls) ? event.payload.calls : [],
    ).length - results.length;
  const failures = results.filter(
    (event) => event.type !== 'tool_finished' || event.payload.isError,
  ).length;
  return (
    <details className="tool-activity">
      <summary>
        <Terminal size={15} />
        <span>
          工具调用 {results.length + Math.max(0, pending)} 次
          {failures > 0 ? ` · ${failures} 次失败或需检查` : ''}
        </span>
        <ChevronDown size={14} />
      </summary>
      <div className="tool-activity-list">
        {results.map((event) => (
          <EventCard key={event.seq} event={event} onQuote={() => {}} />
        ))}
        {pending > 0 && <small>{pending} 项调用尚无结果</small>}
      </div>
    </details>
  );
}

export function EventCard({
  event,
  onQuote,
}: {
  event: SessionEvent;
  onQuote: (event: SessionEvent) => void;
}) {
  if (event.type === 'turn_paused')
    return (
      <div className="pause-banner">
        <CircleAlert size={16} /> 本段运行在
        {event.payload.reason === 'time_limit' ? '时间' : '模型调用'}
        上限处暂停。上方是当时的执行记录。
      </div>
    );
  if (event.type === 'turn_checkpoint')
    return (
      <div className="pause-banner">
        <Check size={16} /> 长任务检查点：已完成 {String(event.payload.modelCalls)} 次模型调用，
        工具返回 {String(event.payload.toolCount)} 项，记录写入{' '}
        {Array.isArray(event.payload.changedFiles) ? event.payload.changedFiles.length : 0} 个文件。
      </div>
    );
  if (event.type === 'run_configured')
    return (
      <div className="pause-banner">
        <Sparkles size={16} /> 长任务已开启：最多 {String(event.payload.maxModelCalls)} 次模型调用；
        {event.payload.allowWorkspaceEdits
          ? '本段允许自动修改工作区文件。'
          : event.payload.unattended
            ? '未授权的文件修改会被拒绝。'
            : '文件修改仍需审批。'}
        {event.payload.unattended ? '未授权操作立即拒绝。' : ''}
      </div>
    );
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
    if (!text) return null;
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
