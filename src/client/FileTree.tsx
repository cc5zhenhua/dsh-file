/**
 * Lazy file tree: lists the workspace root, expands directories on demand,
 * and opens files on click.
 *
 * Creation and rename follow the VS Code interaction: an inline input row
 * inside the tree (Enter to confirm, Esc / blur to cancel) instead of
 * window.prompt, so the flow works identically on web and desktop. Delete
 * stays in the panel (destructive confirm + editor-tab cleanup).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { FileManagerRemote, FileEntry } from './remote.ts';
import { unwrap } from './remote.ts';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** A directory node that has been expanded at least once. */
interface DirNode {
  path: string;
  entries: FileEntry[] | null; // null while loading
  error?: string;
}

/** Inline-editing state: a create draft row, or a rename of an existing node. */
type Editing =
  | { mode: 'create'; parent: string; kind: 'file' | 'directory' }
  | { mode: 'rename'; path: string };

export interface TreeRef {
  /** Refresh the root listing. */
  refresh(): void;
  /**
   * VS Code-style inline creation: expand an input row inside the target
   * directory (selected dir, selected file's parent, else root).
   */
  beginCreate(kind: 'file' | 'directory'): void;
}

interface FileTreeProps {
  remote: FileManagerRemote;
  root: string;
  filter: string;
  onOpenFile: (path: string) => void;
  onDelete: (path: string) => void;
  /** Fired after a successful inline rename so the panel can retitle tabs. */
  onRenamed: (from: string, to: string) => void;
  /** Status-line messages (creation/rename results, validation errors). */
  onNotice: (message: string) => void;
}

export const FileTree = forwardRef<TreeRef, FileTreeProps>(function FileTree(
  { remote, root, filter, onOpenFile, onDelete, onRenamed, onNotice },
  ref,
) {
  const [expanded, setExpanded] = useState<Record<string, DirNode>>({ [root]: { path: root, entries: null } });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [rev, setRev] = useState(0); // bump to reload the root
  /** Paths known to be directories (populated while rendering entries). */
  const dirPaths = useRef<Set<string>>(new Set());
  /** Live mirror of `expanded` so the filter walk reads fresh cache without retriggering itself. */
  const expandedRef = useRef<Record<string, DirNode>>(expanded);
  const [matches, setMatches] = useState<{ path: string; isDir: boolean }[] | null>(null);

  const query = filter.trim().toLowerCase();

  // When a filter is active, recursively walk the tree and collect matching
  // nodes. We cache each directory listing (in a ref mirror of `expanded`) to
  // avoid refetching, expanding lazily-loaded subtrees on demand as the walk
  // proceeds. The mirror keeps the effect self-contained: it can write fetched
  // listings back into state for the normal tree view without depending on
  // `expanded` (which would retrigger the walk on every write).
  useEffect(() => {
    if (query === '') {
      setMatches(null);
      return;
    }
    let cancelled = false;
    setMatches([]);
    const walk = async (dirPath: string): Promise<void> => {
      let entries: FileEntry[];
      const cached = expandedRef.current[dirPath];
      if (cached?.entries !== null && cached?.entries !== undefined) {
        entries = cached.entries;
      } else {
        try {
          const value = unwrap(await remote.listDir(dirPath));
          entries = value.entries;
          if (!cancelled) {
            expandedRef.current = { ...expandedRef.current, [dirPath]: { path: dirPath, entries } };
            setExpanded(expandedRef.current);
          }
        } catch {
          return;
        }
      }
      for (const entry of entries) {
        if (cancelled) return;
        const full = `${dirPath.replace(/\/$/, '')}/${entry.name}`;
        if (entry.name.toLowerCase().includes(query)) {
          setMatches((prev) => (prev === null ? prev : [...prev, { path: full, isDir: entry.type === 'directory' }]));
        }
        if (entry.type === 'directory') await walk(full);
      }
    };
    void walk(root);
    return () => { cancelled = true; };
  }, [query, root, remote]);

  // Keep the ref mirror in sync when the tree mutates `expanded` for other reasons.
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  /** Parent directory of a workspace path (falls back to root). */
  const parentOf = useCallback(
    (p: string): string => {
      const i = p.lastIndexOf('/');
      if (i <= 0) return root;
      return p.slice(0, i) || root;
    },
    [root],
  );

  /** Load (or reload) one directory level. */
  const loadDir = useCallback(
    async (path: string) => {
      setExpanded((prev) => ({ ...prev, [path]: { ...(prev[path] ?? { path }), entries: null, error: undefined } }));
      try {
        const value = unwrap(await remote.listDir(path));
        setExpanded((prev) => ({ ...prev, [path]: { path, entries: value.entries } }));
      } catch (error) {
        setExpanded((prev) => ({ ...prev, [path]: { path, entries: [], error: error instanceof Error ? error.message : String(error) } }));
      }
    },
    [remote],
  );

  // Initial load of the root; root switch drops any pending edit.
  useEffect(() => {
    setEditing(null);
    void loadDir(root);
  }, [root, rev, loadDir]);

  /**
   * Target directory for "new file/dir": the selected directory (expanded or
   * not — VS Code creates inside a collapsed selection too), the selected
   * file's parent, else the root.
   */
  const cwdTarget = useCallback((): string => {
    if (selected === null) return root;
    if (dirPaths.current.has(selected)) return selected;
    return parentOf(selected);
  }, [selected, root, parentOf]);

  const beginCreate = useCallback(
    (kind: 'file' | 'directory') => {
      const parent = cwdTarget();
      // Expand the target so the draft row is visible (root is always open).
      if (parent !== root && expanded[parent] === undefined) void loadDir(parent);
      setSelected(parent);
      setEditing({ mode: 'create', parent, kind });
    },
    [cwdTarget, expanded, loadDir, root],
  );

  useImperativeHandle(ref, () => ({
    refresh: () => setRev((v) => v + 1),
    beginCreate,
  }), [beginCreate]);

  const cancelEdit = useCallback(() => setEditing(null), []);

  /** Confirm an inline create. Returns false to keep the input open. */
  const submitCreate = useCallback(
    async (name: string): Promise<boolean> => {
      if (editing?.mode !== 'create') return true;
      const trimmed = name.trim();
      if (trimmed === '') return true; // empty = cancel silently (like VS Code)
      if (trimmed.includes('/')) {
        onNotice('名称不能包含 /');
        return false;
      }
      const target = `${editing.parent.replace(/\/$/, '')}/${trimmed}`;
      try {
        if (editing.kind === 'directory') await unwrap(await remote.createDirectory(target));
        else await unwrap(await remote.createFile(target));
      } catch (error) {
        onNotice(`创建失败: ${error instanceof Error ? error.message : String(error)}`);
        return false; // keep the input open so the name can be fixed
      }
      await loadDir(editing.parent);
      setEditing(null);
      setSelected(target);
      onNotice(editing.kind === 'directory' ? `已创建目录 ${trimmed}` : `已创建文件 ${trimmed}`);
      if (editing.kind === 'file') onOpenFile(target);
      return true;
    },
    [editing, remote, loadDir, onNotice, onOpenFile],
  );

  /** Confirm an inline rename. Returns false to keep the input open. */
  const submitRename = useCallback(
    async (name: string): Promise<boolean> => {
      if (editing?.mode !== 'rename') return true;
      const from = editing.path;
      const trimmed = name.trim();
      const oldName = from.split('/').pop() ?? '';
      if (trimmed === '' || trimmed === oldName) return true; // unchanged = cancel
      if (trimmed.includes('/')) {
        onNotice('名称不能包含 /');
        return false;
      }
      const to = `${parentOf(from).replace(/\/$/, '')}/${trimmed}`;
      try {
        await unwrap(await remote.rename(from, to));
      } catch (error) {
        onNotice(`重命名失败: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      await loadDir(parentOf(from));
      setEditing(null);
      setSelected(to);
      onRenamed(from, to);
      onNotice(`已重命名 ${trimmed}`);
      return true;
    },
    [editing, remote, loadDir, parentOf, onRenamed, onNotice],
  );

  const node = expanded[root];

  /** Recursively render one level (inline; the tree is shallow by default). */
  const renderLevel = useCallback(
    (path: string, entries: FileEntry[], depth: number): React.ReactNode => {
      const draftHere = editing?.mode === 'create' && editing.parent === path ? editing : null;
      return (
        <>
          {draftHere !== null && (
            <InlineInput
              depth={depth}
              isDir={draftHere.kind === 'directory'}
              initial=""
              onSubmit={submitCreate}
              onCancel={cancelEdit}
            />
          )}
          {entries.map((entry) => {
            const full = `${path.replace(/\/$/, '')}/${entry.name}`;
            const isDir = entry.type === 'directory';
            if (isDir) dirPaths.current.add(full);
            const isOpen = expanded[full] !== undefined;
            const isRenaming = editing?.mode === 'rename' && editing.path === full;
            return (
              <div key={full}>
                {isRenaming ? (
                  <InlineInput
                    depth={depth}
                    isDir={isDir}
                    initial={entry.name}
                    onSubmit={submitRename}
                    onCancel={cancelEdit}
                  />
                ) : (
                  <div
                    className={cx('dshf-node', selected === full && 'dshf-selected')}
                    style={{ paddingLeft: `${8 + depth * 14}px` }}
                    onClick={() => {
                      setSelected(full);
                      if (isDir) {
                        if (isOpen) {
                          setExpanded((prev) => {
                            const next = { ...prev };
                            delete next[full];
                            return next;
                          });
                        } else {
                          void loadDir(full);
                        }
                      } else {
                        onOpenFile(full);
                      }
                    }}
                    onDoubleClick={() => {
                      if (!isDir && selected === full) onOpenFile(full);
                    }}
                    title={full}
                  >
                    <span className="dshf-caret">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
                    <span className={cx('dshf-icon', isDir ? 'dshf-icon-dir' : 'dshf-icon-file')}>{isDir ? '📁' : '📄'}</span>
                    <span className="dshf-name">{entry.name}</span>
                    <span className="dshf-node-actions">
                      <button type="button" className="dshf-mini" title="重命名" onClick={(e) => { e.stopPropagation(); setSelected(full); setEditing({ mode: 'rename', path: full }); }}>✎</button>
                      <button type="button" className="dshf-mini" title="删除" onClick={(e) => { e.stopPropagation(); onDelete(full); }}>🗑</button>
                    </span>
                  </div>
                )}
                {isDir && isOpen && (
                  <DirChildren
                    node={expanded[full]}
                    depth={depth + 1}
                    onRender={renderLevel}
                  />
                )}
              </div>
            );
          })}
        </>
      );
    },
    [expanded, selected, editing, loadDir, onOpenFile, onDelete, submitCreate, submitRename, cancelEdit],
  );

  return (
    <div className="dshf-tree-scroll">
      {matches !== null ? (
        matches.length === 0 ? (
          <div className="dshf-tree-hint">{query === '' ? '输入关键字搜索' : '无匹配结果'}</div>
        ) : (
          <div className="dshf-tree-list">
            {matches.map(({ path: full, isDir }) => (
              <div
                key={full}
                className={cx('dshf-node', selected === full && 'dshf-selected')}
                style={{ paddingLeft: '8px' }}
                onClick={() => {
                  setSelected(full);
                  if (!isDir) onOpenFile(full);
                }}
                onDoubleClick={() => {
                  if (!isDir && selected === full) onOpenFile(full);
                }}
                title={full}
              >
                <span className={cx('dshf-icon', isDir ? 'dshf-icon-dir' : 'dshf-icon-file')}>{isDir ? '📁' : '📄'}</span>
                <span className="dshf-name">{full.slice(root.length).replace(/^\/+/, '')}</span>
                <span className="dshf-node-actions">
                  <button type="button" className="dshf-mini" title="重命名" onClick={(e) => { e.stopPropagation(); setSelected(full); setEditing({ mode: 'rename', path: full }); }}>✎</button>
                  <button type="button" className="dshf-mini" title="删除" onClick={(e) => { e.stopPropagation(); onDelete(full); }}>🗑</button>
                </span>
              </div>
            ))}
          </div>
        )
      ) : node === undefined ? null : node.entries === null ? (
        <div className="dshf-tree-hint">{node.error ? `加载失败: ${node.error}` : '加载中…'}</div>
      ) : (
        <div className="dshf-tree-list">
          {node.entries.length === 0 && editing?.mode !== 'create' && <div className="dshf-tree-hint">（空目录）</div>}
          {renderLevel(root, node.entries, 0)}
        </div>
      )}
    </div>
  );
});

/** Rendered children of one expanded directory (loading state handled here). */
function DirChildren({ node, depth, onRender }: {
  node: DirNode;
  depth: number;
  onRender: (path: string, entries: FileEntry[], depth: number) => React.ReactNode;
}): JSX.Element | null {
  if (node === undefined || node.entries === null) {
    return <div className="dshf-tree-hint" style={{ paddingLeft: `${8 + depth * 14}px` }}>{node?.error ?? '加载中…'}</div>;
  }
  return <>{onRender(node.path, node.entries, depth)}</>;
}

/**
 * VS Code-style inline input row: appears inside the tree for creation drafts
 * and in place of the node label for renames. Enter submits (the handler may
 * veto and keep the input open), Esc / blur cancels.
 */
function InlineInput({ depth, isDir, initial, onSubmit, onCancel }: {
  depth: number;
  isDir: boolean;
  initial: string;
  onSubmit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.focus();
    // VS Code pre-selects the basename without its extension on rename.
    const dot = initial.lastIndexOf('.');
    if (initial !== '' && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial]);

  return (
    <div className="dshf-node dshf-node-editing" style={{ paddingLeft: `${8 + depth * 14}px` }}>
      <span className="dshf-caret" />
      <span className={cx('dshf-icon', isDir ? 'dshf-icon-dir' : 'dshf-icon-file')}>{isDir ? '📁' : '📄'}</span>
      <input
        ref={inputRef}
        className="dshf-inline-input"
        value={value}
        placeholder={initial === '' ? (isDir ? '目录名称' : '文件名称') : undefined}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void onSubmit(value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={onCancel}
      />
    </div>
  );
}
