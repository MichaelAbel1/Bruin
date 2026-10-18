import React, { useRef } from 'react';
import { FileCode, Code2, GitCompare, RotateCcw, Save } from 'lucide-react';
import { computeLineDiff } from './line-diff.js';

export type OpenFile = {
  path: string;
  content: string;
  originalContent: string;
  baselineContent?: string;
  truncated: boolean;
  mode?: 'edit' | 'diff';
  readOnlyReason?: string;
};

type Token = {
  type: 'keyword' | 'string' | 'comment' | 'number' | 'boolean' | 'type' | 'function' | 'text';
  value: string;
};

const tokenRegex =
  /(\/\/.*$|#[^!].*$|\/\*.*?\*\/)|("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`)|(\b(?:const|let|var|function|class|import|export|from|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|async|await|type|interface|extends|implements|public|private|protected|static|readonly|default|as|is|in|of|typeof|instanceof|void|yield|def|fn|pub|struct|impl|trait|enum|match|package|func|select|defer|go|val|self|this)\b)|(\b(?:true|false|null|undefined|None|True|False)\b)|(\b\d+(?:\.\d+)?\b)|(\b[A-Z][a-zA-Z0-9_]*\b)|(\b[a-z_$][a-zA-Z0-9_$]*(?=\s*\())/g;

function tokenizeLine(line: string): Token[] {
  tokenRegex.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const parts: Token[] = [];
  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: line.slice(lastIndex, match.index) });
    }
    const [_, comment, string, keyword, boolNull, number, type, func] = match;
    if (comment) parts.push({ type: 'comment', value: comment });
    else if (string) parts.push({ type: 'string', value: string });
    else if (keyword) parts.push({ type: 'keyword', value: keyword });
    else if (boolNull) parts.push({ type: 'boolean', value: boolNull });
    else if (number) parts.push({ type: 'number', value: number });
    else if (type) parts.push({ type: 'type', value: type });
    else if (func) parts.push({ type: 'function', value: func });
    lastIndex = tokenRegex.lastIndex;
  }
  if (lastIndex < line.length) {
    parts.push({ type: 'text', value: line.slice(lastIndex) });
  }
  return parts;
}

function HighlightedTokens({ text }: { text: string }) {
  if (!text) return <span>&nbsp;</span>;
  const tokens = tokenizeLine(text);
  return (
    <>
      {tokens.map((token, idx) => (
        <span key={idx} className={`token token-${token.type}`}>
          {token.value}
        </span>
      ))}
    </>
  );
}

export function FileEditorViewer({
  file,
  onContentChange,
  onSave,
  onRevert,
  onModeChange,
  saving,
}: {
  file: OpenFile;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onRevert: () => void;
  onModeChange: (mode: 'edit' | 'diff') => void;
  saving: boolean;
}) {
  const isDirty = file.content !== file.originalContent;
  const diffResult = computeLineDiff(file.baselineContent ?? file.originalContent, file.content);
  const mode = file.mode ?? 'edit';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  const addedLines = new Set<number>();
  for (const item of diffResult.diff) {
    if (item.type === 'added' && item.newLine !== undefined) {
      addedLines.add(item.newLine);
    }
  }

  const lines = file.content.split('\n');

  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = e.currentTarget;
    if (gutterRef.current) gutterRef.current.scrollTop = scrollTop;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop;
      highlightRef.current.scrollLeft = scrollLeft;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (isDirty && !file.truncated && !file.readOnlyReason) onSave();
      return;
    }
    if (file.truncated || file.readOnlyReason) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      if (!e.shiftKey) {
        const next = val.substring(0, start) + '  ' + val.substring(end);
        onContentChange(next);
        setTimeout(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        }, 0);
      }
    }
  };

  return (
    <div className="file-editor-container">
      <div className="file-editor-header">
        <div className="file-header-left">
          <FileCode size={17} className="file-header-icon" />
          <strong className="file-path-title" title={file.path}>
            {file.path}
          </strong>
          {isDirty ? (
            <span className="file-status-badge dirty" title="文件有未保存的修改">
              ● 未保存
            </span>
          ) : (
            <span className="file-status-badge clean">
              {file.readOnlyReason ? '只读' : '已保存'}
            </span>
          )}
          {(diffResult.additions > 0 || diffResult.deletions > 0) && (
            <div
              className="diff-badge-pill"
              title={`${diffResult.additions} 行新增, ${diffResult.deletions} 行删除`}
            >
              {diffResult.additions > 0 && (
                <span className="diff-add">+{diffResult.additions}</span>
              )}
              {diffResult.deletions > 0 && (
                <span className="diff-del">-{diffResult.deletions}</span>
              )}
            </div>
          )}
        </div>
        <div className="file-header-actions">
          <div className="editor-mode-toggle" role="group" aria-label="查看模式">
            <button
              className={mode === 'edit' ? 'active' : ''}
              onClick={() => onModeChange('edit')}
              title="代码编辑模式"
            >
              <Code2 size={13} /> 代码
            </button>
            <button
              className={mode === 'diff' ? 'active' : ''}
              onClick={() => onModeChange('diff')}
              title="差异对比模式"
            >
              <GitCompare size={13} />
              对比
              {(diffResult.additions > 0 || diffResult.deletions > 0) && (
                <span className="mode-diff-counts">
                  <span className="diff-add">+{diffResult.additions}</span>
                  <span className="diff-del">-{diffResult.deletions}</span>
                </span>
              )}
            </button>
          </div>
          {isDirty && (
            <button
              className="file-action-btn revert"
              onClick={onRevert}
              title="放弃修改，还原到磁盘文件"
            >
              <RotateCcw size={13} /> 还原
            </button>
          )}
          <button
            className={`file-action-btn save ${isDirty ? 'primary' : ''}`}
            disabled={!isDirty || saving || file.truncated || Boolean(file.readOnlyReason)}
            onClick={onSave}
            title="保存文件 (⌘S / Ctrl+S)"
          >
            <Save size={13} />
            <span>{saving ? '保存中...' : '保存'}</span>
          </button>
        </div>
      </div>
      {file.truncated && (
        <div className="file-warning-banner">
          文件过大，仅显示前 256 KB 内容；预览只读，请使用外部编辑器修改。
        </div>
      )}
      {file.readOnlyReason && <div className="file-warning-banner">{file.readOnlyReason}</div>}
      {mode === 'edit' ? (
        <div className="code-editor-layout">
          <div className="code-gutter" ref={gutterRef}>
            {lines.map((_, idx) => {
              const lineNo = idx + 1;
              const isAdded = addedLines.has(lineNo);
              return (
                <div key={idx} className={`gutter-row ${isAdded ? 'gutter-row-added' : ''}`}>
                  <span className="gutter-marker">{isAdded ? '+' : ''}</span>
                  <span className="gutter-num">{lineNo}</span>
                </div>
              );
            })}
          </div>
          <div className="code-surface">
            <div className="code-highlight-layer" ref={highlightRef}>
              {lines.map((lineText, idx) => {
                const lineNo = idx + 1;
                const isAdded = addedLines.has(lineNo);
                return (
                  <div key={idx} className={`code-row ${isAdded ? 'code-row-added' : ''}`}>
                    <HighlightedTokens text={lineText} />
                  </div>
                );
              })}
            </div>
            <textarea
              ref={textareaRef}
              className="code-editor-textarea"
              value={file.content}
              readOnly={file.truncated || Boolean(file.readOnlyReason)}
              onChange={(e) => onContentChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={handleScroll}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
            />
          </div>
        </div>
      ) : (
        <div className="diff-viewer-surface">
          <table className="diff-table">
            <tbody>
              {diffResult.diff.map((item, idx) => (
                <tr key={idx} className={`diff-tr diff-tr-${item.type}`}>
                  <td className="diff-td-num old-num">{item.oldLine ?? ''}</td>
                  <td className="diff-td-num new-num">{item.newLine ?? ''}</td>
                  <td className="diff-td-sign">
                    {item.type === 'added' ? '+' : item.type === 'deleted' ? '-' : ' '}
                  </td>
                  <td className="diff-td-code">
                    <HighlightedTokens text={item.text} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
