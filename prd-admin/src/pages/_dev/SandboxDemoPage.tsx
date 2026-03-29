import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  addEdge,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

type ElementKind = 'role' | 'mark';
type RoleFamily = 'hq' | 'dealer' | 'store' | 'sales' | 'guide' | 'consumer';
type MarkFamily = 'logistics' | 'qr';
type MarkState = '未入库' | '已入库' | '出货' | '退货' | '已扫码';

type RoleSubtype =
  | '总部'
  | '一级经销商'
  | '二级经销商'
  | '三级经销商'
  | '四级经销商'
  | '门店'
  | '厂家业务员'
  | '一级经销商业务员'
  | '二级经销商业务员'
  | '三级经销商业务员'
  | '四级经销商业务员'
  | '导购员'
  | '消费者';

type MarkSubtype =
  | '大标物流码'
  | '中标物流码'
  | '小标物流码'
  | '垛标物流码'
  | '智能营销码'
  | '终端动销码'
  | '超级导购码';

type LinkState =
  | '出货'
  | '退货'
  | '调拨'
  | '返利'
  | '扫码出货'
  | '扫码退货'
  | '扫码签收'
  | '扫码注册'
  | '未扫码'
  | '扫码未领奖'
  | '扫码已领奖';

type LinkRelation = 'role-role' | 'role-mark';

type NodeData = {
  kind: ElementKind;
  family: RoleFamily | MarkFamily;
  subtype: RoleSubtype | MarkSubtype;
  title: string;
  name?: string;
  region?: string;
  markState?: MarkState;
};

type EdgeData = {
  linkState: LinkState;
  relation: LinkRelation;
  seed: number;
};

type SandboxNode = Node<NodeData, 'sandboxNode'>;
type SandboxEdge = Edge<EdgeData, 'sandboxEdge'>;
type ToolMode = 'select' | 'link';

const ROLE_LINK_STATES: LinkState[] = ['出货', '退货', '调拨', '返利'];
const CROSS_LINK_STATES: LinkState[] = [
  '扫码出货',
  '扫码退货',
  '扫码签收',
  '扫码注册',
  '未扫码',
  '扫码未领奖',
  '扫码已领奖',
];

const MARK_STATES: MarkState[] = ['未入库', '已入库', '出货', '退货', '已扫码'];
const STORAGE_KEY = 'sandbox-demo-v4';

const ROLE_MENU: Array<{ title: string; options: Array<{ family: RoleFamily; subtype: RoleSubtype }> }> = [
  { title: '总部', options: [{ family: 'hq', subtype: '总部' }] },
  {
    title: '经销商',
    options: [
      { family: 'dealer', subtype: '一级经销商' },
      { family: 'dealer', subtype: '二级经销商' },
      { family: 'dealer', subtype: '三级经销商' },
      { family: 'dealer', subtype: '四级经销商' },
    ],
  },
  { title: '门店', options: [{ family: 'store', subtype: '门店' }] },
  {
    title: '业务员',
    options: [
      { family: 'sales', subtype: '厂家业务员' },
      { family: 'sales', subtype: '一级经销商业务员' },
      { family: 'sales', subtype: '二级经销商业务员' },
      { family: 'sales', subtype: '三级经销商业务员' },
      { family: 'sales', subtype: '四级经销商业务员' },
    ],
  },
  { title: '导购员', options: [{ family: 'guide', subtype: '导购员' }] },
  { title: '消费者', options: [{ family: 'consumer', subtype: '消费者' }] },
];

const MARK_MENU: Array<{ title: string; options: Array<{ family: MarkFamily; subtype: MarkSubtype }> }> = [
  {
    title: '物流码',
    options: [
      { family: 'logistics', subtype: '大标物流码' },
      { family: 'logistics', subtype: '中标物流码' },
      { family: 'logistics', subtype: '小标物流码' },
      { family: 'logistics', subtype: '垛标物流码' },
    ],
  },
  {
    title: '营销二维码',
    options: [
      { family: 'qr', subtype: '智能营销码' },
      { family: 'qr', subtype: '终端动销码' },
      { family: 'qr', subtype: '超级导购码' },
    ],
  },
];

function getRoleColor(family: RoleFamily) {
  switch (family) {
    case 'hq':
      return '#5b7cff';
    case 'dealer':
      return '#2ea6ff';
    case 'store':
      return '#26b36b';
    case 'sales':
      return '#f59f00';
    case 'guide':
      return '#f767a1';
    case 'consumer':
      return '#a16eff';
    default:
      return '#6c7a89';
  }
}

function getMarkColor(family: MarkFamily) {
  return family === 'logistics' ? '#13c2c2' : '#ff7a45';
}

function getNodeColor(data: NodeData) {
  return data.kind === 'role'
    ? getRoleColor(data.family as RoleFamily)
    : getMarkColor(data.family as MarkFamily);
}

function getEdgeStates(relation: LinkRelation): LinkState[] {
  return relation === 'role-role' ? ROLE_LINK_STATES : CROSS_LINK_STATES;
}

function getRelation(source: NodeData, target: NodeData): LinkRelation | null {
  if (source.kind === 'role' && target.kind === 'role') return 'role-role';
  if (
    (source.kind === 'role' && target.kind === 'mark') ||
    (source.kind === 'mark' && target.kind === 'role')
  ) {
    return 'role-mark';
  }
  return null;
}

function createNodeId(kind: ElementKind) {
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function calcNextPosition(nodes: SandboxNode[], kind: ElementKind) {
  const sameTypeCount = nodes.filter((node) => node.data.kind === kind).length;
  const rowSize = 6;
  const row = Math.floor(sameTypeCount / rowSize);
  const col = sameTypeCount % rowSize;
  const baseY = kind === 'role' ? 120 : 360;
  return { x: 120 + col * 220, y: baseY + row * 160 };
}

function SandboxNodeRenderer({ data, selected }: NodeProps<SandboxNode>) {
  const color = getNodeColor(data);
  const isRole = data.kind === 'role';

  return (
    <div style={{ minWidth: 138, textAlign: 'center', position: 'relative' }}>
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />

      {isRole && (data.name || data.region) ? (
        <div
          style={{
            position: 'absolute',
            top: -30,
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: 11,
            lineHeight: '14px',
            color: '#dbe6ff',
            whiteSpace: 'nowrap',
            background: 'rgba(6,12,28,0.85)',
            border: '1px solid rgba(145,178,255,0.35)',
            borderRadius: 6,
            padding: '2px 7px',
          }}
        >
          {data.name || '未命名'}
          {data.region ? ` · ${data.region}` : ''}
        </div>
      ) : null}

      {!isRole && data.markState ? (
        <div
          style={{
            position: 'absolute',
            top: -28,
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: 11,
            color: '#fff1d6',
            whiteSpace: 'nowrap',
            background: 'rgba(44,21,6,0.9)',
            border: '1px solid rgba(255,173,96,0.45)',
            borderRadius: 6,
            padding: '2px 7px',
          }}
        >
          {data.markState}
        </div>
      ) : null}

      {isRole ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 999,
              border: `2px solid ${color}`,
              background: 'rgba(7, 11, 20, 0.96)',
              boxShadow: selected ? `0 0 0 3px ${color}55` : 'none',
            }}
          />
          <div
            style={{
              minWidth: 108,
              borderRadius: 10,
              padding: '10px 14px',
              border: `1px solid ${color}`,
              background: `${color}26`,
              color: '#f3f8ff',
              fontWeight: 600,
              fontSize: 13,
              boxShadow: selected ? `0 0 0 3px ${color}4d` : 'none',
            }}
          >
            {data.title}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(220,230,255,0.88)' }}>{data.subtype}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <div
            style={{
              width: 88,
              height: 88,
              borderRadius: 10,
              border: `2px solid ${color}`,
              background: '#fcfcff',
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gridTemplateRows: 'repeat(5, 1fr)',
              gap: 2,
              padding: 7,
              boxShadow: selected ? `0 0 0 3px ${color}4d` : 'none',
            }}
          >
            {Array.from({ length: 25 }).map((_, idx) => {
              const black = ((idx * 7 + data.subtype.length) % 3) !== 1;
              return <div key={idx} style={{ background: black ? color : '#fff', borderRadius: 1 }} />;
            })}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#f4f8ff' }}>{data.title}</div>
          <div style={{ fontSize: 11, color: 'rgba(220,230,255,0.88)' }}>{data.subtype}</div>
        </div>
      )}
    </div>
  );
}

function SandboxEdgeRenderer({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps<SandboxEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });

  const seed = data?.seed ?? 0;
  const offsetX = ((seed % 17) - 8) * 2.6;
  const offsetY = (((seed / 17) % 11) - 5) * 3.2;
  const label = data?.linkState ?? '';

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? '#ffd166' : '#89b4ff',
          strokeWidth: selected ? 2.4 : 1.8,
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX + offsetX}px, ${labelY + offsetY}px)`,
            pointerEvents: 'none',
            fontSize: 11,
            color: '#f8fbff',
            padding: '2px 8px',
            borderRadius: 999,
            background: 'rgba(12,18,34,0.82)',
            border: '1px solid rgba(145,178,255,0.42)',
            whiteSpace: 'nowrap',
          }}
          className="nodrag nopan"
        >
          {label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { sandboxNode: SandboxNodeRenderer };
const edgeTypes = { sandboxEdge: SandboxEdgeRenderer };

function ToolbarButton({
  active,
  label,
  onClick,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap"
      style={{
        border: active ? '1px solid rgba(255,214,102,0.75)' : '1px solid rgba(120,148,206,0.45)',
        background: active ? 'rgba(255,214,102,0.2)' : 'rgba(10,18,36,0.9)',
        color: active ? '#fff2c7' : '#deebff',
        borderRadius: 10,
        padding: '9px 14px',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function SandboxDemoInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<SandboxNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SandboxEdge>([]);

  const [toolMode, setToolMode] = useState<ToolMode>('select');
  const [spacePressed, setSpacePressed] = useState(false);

  const [showRoleMenu, setShowRoleMenu] = useState(false);
  const [showMarkMenu, setShowMarkMenu] = useState(false);
  const [selectedRoleKeys, setSelectedRoleKeys] = useState<Record<string, boolean>>({});
  const [selectedMarkKeys, setSelectedMarkKeys] = useState<Record<string, boolean>>({});

  const [pendingLinkSourceId, setPendingLinkSourceId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);

  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editingRoleName, setEditingRoleName] = useState('');
  const [editingRoleRegion, setEditingRoleRegion] = useState('');

  const [editingMarkId, setEditingMarkId] = useState<string | null>(null);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);

  const editingEdge = useMemo(
    () => (editingEdgeId ? edges.find((edge) => edge.id === editingEdgeId) : undefined),
    [edges, editingEdgeId]
  );

  const currentEdgeStates = useMemo(() => {
    if (!editingEdge?.data?.relation) return [];
    return getEdgeStates(editingEdge.data.relation);
  }, [editingEdge]);

  const summaryText = useMemo(() => {
    if (toolMode !== 'link') return '模式：选择';
    if (!pendingLinkSourceId) return '模式：连线（点击第一个组件）';
    const sourceNode = nodes.find((node) => node.id === pendingLinkSourceId);
    return `模式：连线（已选起点 ${sourceNode?.data.title ?? '未知'}，请点击终点）`;
  }, [nodes, pendingLinkSourceId, toolMode]);

  const buildEdge = useCallback(
    (sourceId: string, targetId: string) => {
      const sourceNode = nodes.find((node) => node.id === sourceId);
      const targetNode = nodes.find((node) => node.id === targetId);
      if (!sourceNode || !targetNode) return null;

      const relation = getRelation(sourceNode.data, targetNode.data);
      if (!relation) return null;
      const stateList = getEdgeStates(relation);
      const defaultState = stateList[0];

      const edge: SandboxEdge = {
        id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        source: sourceId,
        target: targetId,
        type: 'sandboxEdge',
        markerEnd: { type: MarkerType.ArrowClosed, color: '#89b4ff' },
        data: {
          relation,
          linkState: defaultState,
          seed: Math.floor(Math.random() * 999),
        },
      };
      return edge;
    },
    [nodes]
  );

  const addSelectedRoles = useCallback(() => {
    const picked = ROLE_MENU.flatMap((group) => group.options).filter(
      (option) => selectedRoleKeys[`${option.family}:${option.subtype}`]
    );
    if (picked.length === 0) return;
    setNodes((curr) => {
      const next = [...curr];
      picked.forEach((item) => {
        const position = calcNextPosition(next, 'role');
        next.push({
          id: createNodeId('role'),
          type: 'sandboxNode',
          draggable: true,
          position,
          data: {
            kind: 'role',
            family: item.family,
            subtype: item.subtype,
            title: item.subtype,
          },
        });
      });
      return next;
    });
    setShowRoleMenu(false);
    setSelectedRoleKeys({});
  }, [selectedRoleKeys, setNodes]);

  const addSelectedMarks = useCallback(() => {
    const picked = MARK_MENU.flatMap((group) => group.options).filter(
      (option) => selectedMarkKeys[`${option.family}:${option.subtype}`]
    );
    if (picked.length === 0) return;
    setNodes((curr) => {
      const next = [...curr];
      picked.forEach((item) => {
        const position = calcNextPosition(next, 'mark');
        next.push({
          id: createNodeId('mark'),
          type: 'sandboxNode',
          draggable: true,
          position,
          data: {
            kind: 'mark',
            family: item.family,
            subtype: item.subtype,
            title: item.subtype.replace('物流码', '').replace('营销码', '').replace('码', '码'),
            markState: '未入库',
          },
        });
      });
      return next;
    });
    setShowMarkMenu(false);
    setSelectedMarkKeys({});
  }, [selectedMarkKeys, setNodes]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: SandboxNode) => {
      if (toolMode !== 'link') return;
      if (!pendingLinkSourceId) {
        setPendingLinkSourceId(node.id);
        return;
      }
      if (pendingLinkSourceId === node.id) {
        setPendingLinkSourceId(null);
        return;
      }
      const newEdge = buildEdge(pendingLinkSourceId, node.id);
      if (newEdge) {
        setEdges((curr) => addEdge(newEdge, curr));
      }
      setPendingLinkSourceId(null);
    },
    [buildEdge, pendingLinkSourceId, setEdges, toolMode]
  );

  const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: SandboxNode) => {
    if (node.data.kind === 'role') {
      setEditingRoleId(node.id);
      setEditingRoleName(node.data.name ?? '');
      setEditingRoleRegion(node.data.region ?? '');
    } else {
      setEditingMarkId(node.id);
    }
  }, []);

  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: SandboxEdge) => {
    setEditingEdgeId(edge.id);
  }, []);

  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
    setSelectedNodeIds(selectedNodes.map((node) => node.id));
    setSelectedEdgeIds(selectedEdges.map((edge) => edge.id));
  }, []);

  const deleteSelected = useCallback(() => {
    if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return;
    setNodes((curr) => curr.filter((node) => !selectedNodeIds.includes(node.id)));
    setEdges((curr) =>
      curr.filter(
        (edge) =>
          !selectedEdgeIds.includes(edge.id) &&
          !selectedNodeIds.includes(edge.source) &&
          !selectedNodeIds.includes(edge.target)
      )
    );
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setEditingEdgeId(null);
  }, [selectedEdgeIds, selectedNodeIds, setEdges, setNodes]);

  const saveRoleEdit = useCallback(() => {
    if (!editingRoleId) return;
    setNodes((curr) =>
      curr.map((node) =>
        node.id === editingRoleId
          ? {
              ...node,
              data: {
                ...node.data,
                name: editingRoleName.trim(),
                region: editingRoleRegion.trim(),
              },
            }
          : node
      )
    );
    setEditingRoleId(null);
  }, [editingRoleId, editingRoleName, editingRoleRegion, setNodes]);

  const applyMarkState = useCallback(
    (state: MarkState) => {
      if (!editingMarkId) return;
      setNodes((curr) =>
        curr.map((node) =>
          node.id === editingMarkId ? { ...node, data: { ...node.data, markState: state } } : node
        )
      );
      setEditingMarkId(null);
    },
    [editingMarkId, setNodes]
  );

  const applyEdgeState = useCallback(
    (state: LinkState) => {
      if (!editingEdgeId) return;
      setEdges((curr) =>
        curr.map((edge) =>
          edge.id === editingEdgeId
            ? {
                ...edge,
                data: { ...(edge.data as EdgeData), linkState: state, seed: Math.floor(Math.random() * 999) },
              }
            : edge
        )
      );
      setEditingEdgeId(null);
    },
    [editingEdgeId, setEdges]
  );

  const clearAll = useCallback(() => {
    setNodes([]);
    setEdges([]);
    setPendingLinkSourceId(null);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    localStorage.removeItem(STORAGE_KEY);
  }, [setEdges, setNodes]);

  const saveLocal = useCallback(() => {
    const payload = { nodes, edges };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [edges, nodes]);

  const loadLocal = useCallback(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { nodes: SandboxNode[]; edges: SandboxEdge[] };
      if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        setNodes(parsed.nodes);
        setEdges(parsed.edges);
      }
    } catch {
      // ignore invalid local data
    }
  }, [setEdges, setNodes]);

  useEffect(() => {
    loadLocal();
  }, [loadLocal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (typing) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setSpacePressed(true);
      }
      if (event.key === 'Delete') {
        deleteSelected();
      }
      if (event.key === 'Escape') {
        setPendingLinkSourceId(null);
        setEditingEdgeId(null);
        setEditingRoleId(null);
        setEditingMarkId(null);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault();
        setSpacePressed(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [deleteSelected]);

  return (
    <div style={{ height: '100vh', width: '100%', background: '#060d1d', color: '#e7f0ff', position: 'relative' }}>
      <div
        style={{
          position: 'absolute',
          zIndex: 10,
          top: 12,
          left: 12,
          padding: '8px 10px',
          borderRadius: 10,
          border: '1px solid rgba(120,148,206,0.35)',
          background: 'rgba(7,14,30,0.84)',
          fontSize: 12,
        }}
      >
        一个让复杂业务逻辑“看得见、摸得着、拖得动”的交互式沙盘 Agent
      </div>

      <div
        style={{
          position: 'absolute',
          zIndex: 10,
          top: 12,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
        }}
      >
        <ToolbarButton label="保存" onClick={saveLocal} />
        <ToolbarButton label="加载" onClick={loadLocal} />
        <ToolbarButton label="清空" onClick={clearAll} />
      </div>

      <ReactFlow<SandboxNode, SandboxEdge>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeClick={onEdgeClick}
        onSelectionChange={onSelectionChange}
        onPaneClick={() => {
          if (toolMode === 'link') setPendingLinkSourceId(null);
        }}
        fitView
        selectionOnDrag={!spacePressed}
        panOnDrag={spacePressed}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={null}
        deleteKeyCode={null}
        attributionPosition="bottom-right"
      >
        <Background gap={24} size={1} color="rgba(126,162,235,0.15)" />
        <MiniMap
          pannable
          zoomable
          style={{ background: 'rgba(7,14,30,0.8)', border: '1px solid rgba(120,148,206,0.35)' }}
          nodeColor={(node) => getNodeColor(node.data as NodeData)}
        />
        <Controls />
      </ReactFlow>

      <div
        style={{
          position: 'absolute',
          left: 16,
          bottom: 16,
          zIndex: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: 10,
          borderRadius: 12,
          border: '1px solid rgba(120,148,206,0.35)',
          background: 'rgba(7,14,30,0.88)',
        }}
      >
        <ToolbarButton
          label="添加角色"
          active={showRoleMenu}
          onClick={() => {
            setShowRoleMenu((prev) => !prev);
            setShowMarkMenu(false);
          }}
        />
        <ToolbarButton
          label="添加标识"
          active={showMarkMenu}
          onClick={() => {
            setShowMarkMenu((prev) => !prev);
            setShowRoleMenu(false);
          }}
        />
        <ToolbarButton
          label="连线"
          active={toolMode === 'link'}
          onClick={() => {
            setToolMode((prev) => (prev === 'link' ? 'select' : 'link'));
            setPendingLinkSourceId(null);
          }}
        />
        <ToolbarButton label="删除" onClick={deleteSelected} />
      </div>

      <div
        style={{
          position: 'absolute',
          left: 16,
          bottom: 82,
          zIndex: 12,
          borderRadius: 10,
          border: '1px solid rgba(120,148,206,0.35)',
          background: 'rgba(7,14,30,0.88)',
          color: '#d8e7ff',
          fontSize: 12,
          padding: '7px 10px',
        }}
      >
        {summaryText}
      </div>

      {showRoleMenu ? (
        <div
          style={{
            position: 'absolute',
            left: 16,
            bottom: 132,
            zIndex: 13,
            width: 318,
            maxHeight: 360,
            overflow: 'auto',
            borderRadius: 12,
            border: '1px solid rgba(120,148,206,0.35)',
            background: 'rgba(6,12,28,0.96)',
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 10 }}>添加角色</div>
          {ROLE_MENU.map((group) => (
            <div key={group.title} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: '#9fc2ff', marginBottom: 6 }}>{group.title}</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {group.options.map((option) => {
                  const key = `${option.family}:${option.subtype}`;
                  return (
                    <label key={key} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedRoleKeys[key])}
                        onChange={(event) =>
                          setSelectedRoleKeys((curr) => ({ ...curr, [key]: event.target.checked }))
                        }
                      />
                      <span>{option.subtype}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={addSelectedRoles}
            className="whitespace-nowrap"
            style={{
              width: '100%',
              marginTop: 6,
              borderRadius: 8,
              border: '1px solid rgba(115,182,255,0.55)',
              background: 'rgba(49,115,255,0.25)',
              color: '#eaf2ff',
              padding: '8px 12px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            确认添加角色
          </button>
        </div>
      ) : null}

      {showMarkMenu ? (
        <div
          style={{
            position: 'absolute',
            left: 16,
            bottom: 132,
            zIndex: 13,
            width: 318,
            maxHeight: 360,
            overflow: 'auto',
            borderRadius: 12,
            border: '1px solid rgba(120,148,206,0.35)',
            background: 'rgba(6,12,28,0.96)',
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 10 }}>添加标识</div>
          {MARK_MENU.map((group) => (
            <div key={group.title} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: '#9fc2ff', marginBottom: 6 }}>{group.title}</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {group.options.map((option) => {
                  const key = `${option.family}:${option.subtype}`;
                  return (
                    <label key={key} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedMarkKeys[key])}
                        onChange={(event) =>
                          setSelectedMarkKeys((curr) => ({ ...curr, [key]: event.target.checked }))
                        }
                      />
                      <span>{option.subtype}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={addSelectedMarks}
            className="whitespace-nowrap"
            style={{
              width: '100%',
              marginTop: 6,
              borderRadius: 8,
              border: '1px solid rgba(115,182,255,0.55)',
              background: 'rgba(49,115,255,0.25)',
              color: '#eaf2ff',
              padding: '8px 12px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            确认添加标识
          </button>
        </div>
      ) : null}

      {editingRoleId ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            background: 'rgba(3, 7, 16, 0.56)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <div
            style={{
              width: 340,
              borderRadius: 12,
              border: '1px solid rgba(120,148,206,0.4)',
              background: 'rgba(7,14,30,0.98)',
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 10 }}>编辑角色信息</div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>名称</div>
            <input
              value={editingRoleName}
              onChange={(event) => setEditingRoleName(event.target.value)}
              placeholder="可选，例：华东二级经销商"
              style={{
                width: '100%',
                marginBottom: 10,
                borderRadius: 8,
                border: '1px solid rgba(120,148,206,0.45)',
                background: 'rgba(11,20,42,0.9)',
                color: '#e8f0ff',
                padding: '8px 10px',
                fontSize: 13,
              }}
            />
            <div style={{ fontSize: 12, marginBottom: 4 }}>区域（可选）</div>
            <input
              value={editingRoleRegion}
              onChange={(event) => setEditingRoleRegion(event.target.value)}
              placeholder="例：华北 / 上海"
              style={{
                width: '100%',
                marginBottom: 12,
                borderRadius: 8,
                border: '1px solid rgba(120,148,206,0.45)',
                background: 'rgba(11,20,42,0.9)',
                color: '#e8f0ff',
                padding: '8px 10px',
                fontSize: 13,
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <ToolbarButton label="取消" onClick={() => setEditingRoleId(null)} />
              <ToolbarButton label="保存" onClick={saveRoleEdit} />
            </div>
          </div>
        </div>
      ) : null}

      {editingMarkId ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            background: 'rgba(3, 7, 16, 0.56)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <div
            style={{
              width: 340,
              borderRadius: 12,
              border: '1px solid rgba(120,148,206,0.4)',
              background: 'rgba(7,14,30,0.98)',
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 10 }}>选择标识状态</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {MARK_STATES.map((state) => (
                <button
                  type="button"
                  key={state}
                  onClick={() => applyMarkState(state)}
                  className="whitespace-nowrap"
                  style={{
                    borderRadius: 8,
                    border: '1px solid rgba(120,148,206,0.45)',
                    background: 'rgba(14,25,51,0.88)',
                    color: '#eaf2ff',
                    textAlign: 'left',
                    padding: '8px 10px',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  {state}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
              <ToolbarButton label="关闭" onClick={() => setEditingMarkId(null)} />
            </div>
          </div>
        </div>
      ) : null}

      {editingEdgeId && editingEdge ? (
        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 96,
            zIndex: 14,
            width: 240,
            borderRadius: 12,
            border: '1px solid rgba(120,148,206,0.4)',
            background: 'rgba(7,14,30,0.96)',
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 10 }}>选择连线状态</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {currentEdgeStates.map((state) => (
              <button
                type="button"
                key={state}
                onClick={() => applyEdgeState(state)}
                className="whitespace-nowrap"
                style={{
                  borderRadius: 8,
                  border: '1px solid rgba(120,148,206,0.45)',
                  background:
                    state === editingEdge.data?.linkState ? 'rgba(255,214,102,0.2)' : 'rgba(14,25,51,0.88)',
                  color: '#eaf2ff',
                  textAlign: 'left',
                  padding: '8px 10px',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                {state}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <ToolbarButton label="关闭" onClick={() => setEditingEdgeId(null)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function SandboxDemoPage() {
  return (
    <ReactFlowProvider>
      <SandboxDemoInner />
    </ReactFlowProvider>
  );
}
