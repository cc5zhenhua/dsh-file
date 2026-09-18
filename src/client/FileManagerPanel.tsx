/**
 * File manager SIDEBAR panel: the tree-only view shown while the file manager
 * is open. Clicking a file loads it into the shared store; the center-column
 * "文件" view (`conversation.view`) then displays and edits it inside the
 * page — never a popup, never inside the narrow sidebar.
 *
 * On mount it resolves the CURRENT conversation's workspace directory from the
 * session list (`SessionSummary.cwd`) and re-pins the host gateway root via
 * `remote.setRoot`, so the tree always reflects the active session's workspace
 * instead of the directory `dsh web` was launched from. When no session is
 * open yet it falls back to the gateway's configured root.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileManagerRemote, FileEntry } from './remote.ts';
import { unwrap } from './remote.ts';
import { FileTree, type TreeRef } from './FileTree.tsx';
import { openTab, removeTabs, renameTab, setWorkspaceRoot } from './store.ts';

/** Simple classnames helper (no deps). */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * 工具条图标，内联自 @deepseek-ai/dsh-client-ui-primitives
 * （IconPlusOutline16 / IconProjectAddOutline16），与 DSH 自家 UI 同一套
 * 视觉；fill=currentColor 随主题变色。避免给插件新增运行时依赖。
 */
function IconPlus(props: { size?: number }): JSX.Element {
  const size = props.size ?? 16;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z" fill="currentColor" />
    </svg>
  );
}

function IconFolderAdd(props: { size?: number }): JSX.Element {
  const size = props.size ?? 16;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <path transform="translate(9.52 2.52)" d="M3.55246 0L3.55246 2.44252L6 2.44252L6 3.55748L3.55246 3.55748L3.55246 6L2.43834 6L2.43834 3.55748L0 3.55748L0 2.44252L2.43834 2.44252L2.43834 0L3.55246 0Z" fill="currentColor" />
      <path transform="translate(0.3496 2.35)" d="M4.76367 0C5.36861 1.80598e-05 5.93113 0.310294 6.25488 0.821289L6.78027 1.64941C6.79685 1.67558 6.81791 1.69775 6.83887 1.71973C6.72186 2.15521 6.65702 2.61192 6.65137 3.08301C6.25601 2.96045 5.90909 2.70478 5.68164 2.3457L5.15723 1.5166C5.07183 1.38189 4.92318 1.3008 4.76367 1.30078L2.32422 1.30078C1.7589 1.30078 1.30078 1.7589 1.30078 2.32422L1.30078 10.1338C1.30078 10.6991 1.7589 11.1572 2.32422 11.1572L11.9766 11.1572C12.5419 11.1572 13 10.6991 13 8.58398C13.4545 8.5135 13.8903 8.38748 14.3008 8.21289L14.3008 10.1338C14.3008 11.4171 13.2598 12.458 11.9766 12.458L2.32422 12.458C1.04093 12.458 0 11.4171 0 10.1338L0 2.32422C0 1.04093 1.04093 0 2.32422 0L4.76367 0Z" fill="currentColor" />
    </svg>
  );
}

interface FileManagerPanelProps {
  /** The mounted remote face (ctx.remote.fileManager after $mount). */
  remote: FileManagerRemote;
  /** Called when the user closes the panel (returns to the workspace browser). */
  onClose: () => void;
  /** Standard sidebar.workspaces kit: read the current session's workspace. */
  useSessions?: FileManagerSessionHook;
  /** Called after a file tab opens: bring the center "文件" view to the front. */
  onFileOpened?: () => void;
}

/** Structural view of the standard useSessions selector hook (sidebar.workspaces kit). */
export type FileManagerSessionHook = <S>(
  sel: (s: { current?: string; byId: Record<string, { cwd?: string }> }) => S,
  eq?: (a: S, b: S) => boolean,
) => S;

export function FileManagerPanel({ remote, onClose, useSessions, onFileOpened }: FileManagerPanelProps): JSX.Element | null {
  const [root, setRoot] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const treeRef = useRef<TreeRef>(null);
  const [filter, setFilter] = useState('');

  // Current conversation's workspace directory (SessionHeader.cwd), if any.
  const sessionCwd = useSessions
    ? useSessions((s) => (s.current !== undefined ? s.byId[s.current]?.cwd : undefined))
    : undefined;

  // Re-pin the gateway root to the active session's workspace; refresh the tree.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (sessionCwd !== undefined) {
          try {
            await unwrap(await remote.setRoot(sessionCwd));
          } catch {
            // setRoot unavailable (host not restarted yet): keep the configured root.
          }
        }
        const { path } = unwrap(await remote.getRoot());
        if (!cancelled) {
          setRoot(path);
          setRootError(null);
          // Tell the editor store which workspace these files belong to. This
          // clears pristine editor state on a genuine workspace SWITCH (so
          // stale tabs from a previous workspace don't linger), while treating
          // the same root as a no-op — so toggling to the "对话" view and back
          // keeps all open tabs and unsaved edits. The panel's own unmount must
          // NOT wipe editor state: the panel unmounts whenever the "文件" view
          // loses focus, which is a normal navigation, not a close gesture.
          setWorkspaceRoot(path);
        }
      } catch (error) {
        if (!cancelled) setRootError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [remote, sessionCwd]);

  // NOTE: do NOT reset editor state on panel unmount. The panel unmounts
  // whenever the "文件" conversation view loses focus (the sidebar sync in
  // index.tsx closes it), which is normal navigation — wiping tabs here would
  // silently discard unsaved edits. Editor state is reset only when the
  // workspace root actually changes (see setWorkspaceRoot above).

  const handleNotice = useCallback((message: string) => {
    setNotice(message);
  }, []);

  /** Open a file: read it if not already open, focus its tab, then switch the center view. */
  const openFile = useCallback(
    async (path: string) => {
      setBusy(true);
      try {
        const value = unwrap(await remote.readText(path));
        openTab({ path, content: value.content, savedContent: value.content, mtimeMs: value.mtimeMs, dirty: false });
        onFileOpened?.();
      } catch (error) {
        handleNotice(`打开失败: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [remote, handleNotice, onFileOpened],
  );

  /** VS Code-style inline creation: the tree expands an input row in the target dir. */
  const handleCreate = useCallback((kind: 'file' | 'directory') => {
    treeRef.current?.beginCreate(kind);
  }, []);

  /** After an inline rename succeeds, retitle any open editor tab. */
  const handleRenamed = useCallback((from: string, to: string) => {
    renameTab(from, to);
  }, []);

  /**
   * Delete the currently selected tree node. Confirmation is an in-page modal
   * (window.confirm is unavailable in the desktop Electron renderer, and
   * blocked/awkward on web), so the flow works identically on both ends.
   */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const handleDelete = useCallback((path: string) => {
    setPendingDelete(path);
  }, []);

  const confirmDelete = useCallback(
    async () => {
      const path = pendingDelete;
      setPendingDelete(null);
      if (path === null) return;
      setBusy(true);
      try {
        await unwrap(await remote.delete(path));
        removeTabs([path]);
        treeRef.current?.refresh();
        handleNotice('已删除');
      } catch (error) {
        handleNotice(`删除失败: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [pendingDelete, remote, handleNotice],
  );

  const title = useMemo(() => {
    if (root === null) return '…';
    return root.split('/').filter(Boolean).pop() || '/';
  }, [root]);

  return (
    <div className="dshf-root">
      <div className="dshf-toolbar">
        <span className="dshf-title" title={root ?? ''}>{title}</span>
        <span className="dshf-spacer" />
        <button type="button" className="dshf-btn dshf-btn-icon" title="新建文件" aria-label="新建文件" onClick={() => handleCreate('file')}><IconPlus /></button>
        <button type="button" className="dshf-btn dshf-btn-icon" title="新建目录" aria-label="新建目录" onClick={() => handleCreate('directory')}><IconFolderAdd /></button>
        <button type="button" className="dshf-btn dshf-btn-icon" title="关闭文件管理器" aria-label="关闭文件管理器" onClick={onClose}>✕</button>
      </div>

      {rootError !== null && <div className="dshf-error">{rootError}</div>}

      <div className="dshf-search">
        <input
          type="search"
          className="dshf-search-input"
          placeholder="搜索文件 / 目录"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="搜索文件"
        />
      </div>

      <div className="dshf-tree-pane">
        {root !== null && (
          <FileTree
            ref={treeRef}
            remote={remote}
            root={root}
            filter={filter}
            onOpenFile={(p) => void openFile(p)}
            onDelete={(p) => void handleDelete(p)}
            onRenamed={handleRenamed}
            onNotice={handleNotice}
          />
        )}
      </div>

      <div className="dshf-status">
        <span className="dshf-status-busy">{busy ? '…' : ''}</span>
        <span className={cx('dshf-status-notice', notice === null && 'dshf-hidden')}>{notice ?? ''}</span>
        <span className="dshf-spacer" />
        <span className="dshf-status-hint">点文件后在上方「文件」标签中编辑</span>
      </div>

      {pendingDelete !== null && (
        <DeleteConfirmDialog
          path={pendingDelete}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/**
 * In-page delete confirmation (VS Code-style modal). Replaces window.confirm,
 * which the desktop Electron renderer does not implement.
 */
function DeleteConfirmDialog({ path, onConfirm, onCancel }: {
  path: string;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const name = path.split('/').pop() ?? path;
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className="dshf-modal-overlay"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="dshf-modal" role="alertdialog" aria-modal="true" aria-label="删除确认" onClick={(e) => e.stopPropagation()}>
        <div className="dshf-modal-title">删除 {name}</div>
        <div className="dshf-modal-body">确定删除 {name} 吗？此操作不可撤销。</div>
        <div className="dshf-modal-actions">
          <button type="button" className="dshf-btn" onClick={onCancel}>取消</button>
          <button ref={confirmRef} type="button" className="dshf-btn dshf-btn-danger" onClick={onConfirm}>删除</button>
        </div>
      </div>
    </div>
  );
}

export type { FileEntry };
