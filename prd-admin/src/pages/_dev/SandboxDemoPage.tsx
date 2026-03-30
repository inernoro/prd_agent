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
  laneOffset?: number;
};

type SandboxNode = Node<NodeData, 'sandboxNode'>;
type SandboxEdge = Edge<EdgeData, 'sandboxEdge'>;
type ToolMode = 'select' | 'link';
type RoleOption = { family: RoleFamily; subtype: RoleSubtype };
type MarkOption = { family: MarkFamily; subtype: MarkSubtype };

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
const SNAP_GRID: [number, number] = [20, 20];
const SNAP_THRESHOLD = 18;

const ROLE_MENU: Array<{ title: string; options: RoleOption[] }> = [
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

const MARK_MENU: Array<{ title: string; options: MarkOption[] }> = [
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

const ALL_ROLE_OPTIONS: RoleOption[] = ROLE_MENU.flatMap((group) => group.options);
const ALL_MARK_OPTIONS: MarkOption[] = MARK_MENU.flatMap((group) => group.options);

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

function getNodeDisplayText(data: NodeData) {
  const name = data.name?.trim();
  return name ? name : data.title;
}

function calcNextPosition(nodes: SandboxNode[], kind: ElementKind) {
  const sameTypeCount = nodes.filter((node) => node.data.kind === kind).length;
  const rowSize = 6;
  const row = Math.floor(sameTypeCount / rowSize);
  const col = sameTypeCount % rowSize;
  const baseY = kind === 'role' ? 120 : 360;
  return { x: 120 + col * 220, y: baseY + row * 160 };
}

function getSnappedPosition(
  nodeId: string,
  position: { x: number; y: number },
  nodes: SandboxNode[]
) {
  let x = Math.round(position.x / SNAP_GRID[0]) * SNAP_GRID[0];
  let y = Math.round(position.y / SNAP_GRID[1]) * SNAP_GRID[1];

  nodes.forEach((node) => {
    if (node.id === nodeId) return;
    if (Math.abs(node.position.x - x) <= SNAP_THRESHOLD) x = node.position.x;
    if (Math.abs(node.position.y - y) <= SNAP_THRESHOLD) y = node.position.y;
  });

  return { x, y };
}

function getBidirectionalLaneOffset(
  sourceId: string,
  targetId: string,
  edges: SandboxEdge[]
) {
  const hasReverse = edges.some(
    (edge) => edge.source === targetId && edge.target === sourceId
  );
  return hasReverse ? 26 : 0;
}

function getShiftedPoints(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  laneOffset: number
) {
  if (!laneOffset) {
    return { sourceX, sourceY, targetX, targetY };
  }
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy) || 1;
  const normalX = -dy / length;
  const normalY = dx / length;
  return {
    sourceX: sourceX + normalX * laneOffset,
    sourceY: sourceY + normalY * laneOffset,
    targetX: targetX + normalX * laneOffset,
    targetY: targetY + normalY * laneOffset,
  };
}

function SandboxNodeRenderer({ data, selected }: NodeProps<SandboxNode>) {
  const color = getNodeColor(data);
  const isRole = data.kind === 'role';
  const roleIconMap: Record<RoleFamily, string> = {
    hq: 'H',
    dealer: 'D',
    store: 'S',
    sales: 'Y',
    guide: 'G',
    consumer: 'C',
  };
  const roleIcon = roleIconMap[data.family as RoleFamily] ?? 'R';

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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: 999,
              border: `2px solid ${color}`,
              background: 'rgba(7, 11, 20, 0.96)',
              boxShadow: selected ? `0 0 0 3px ${color}55` : '0 6px 12px rgba(4,10,22,0.35)',
            }}
          />
          <div
            style={{
              minWidth: 138,
              borderRadius: 12,
              padding: 8,
              border: `1px solid ${color}`,
              background: `linear-gradient(180deg, ${color}2f, ${color}1a)`,
              color: '#f3f8ff',
              boxShadow: selected ? `0 0 0 3px ${color}4d` : '0 8px 16px rgba(8,16,34,0.38)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 7,
                  border: `1px solid ${color}`,
                  background: 'rgba(7, 11, 20, 0.92)',
                  color: '#e7f0ff',
                  fontSize: 11,
                  fontWeight: 700,
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                {roleIcon}
              </div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: 13, lineHeight: '16px' }}>{data.title}</div>
                <div style={{ fontSize: 10, color: 'rgba(225,236,255,0.75)', lineHeight: '13px' }}>{data.subtype}</div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7 }}>
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 14,
              border: `2px solid ${color}`,
              background: 'linear-gradient(180deg, #fcfeff, #f4f8ff)',
              padding: 8,
              boxShadow: selected ? `0 0 0 3px ${color}4d` : '0 8px 16px rgba(8,16,34,0.35)',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 7,
                top: 7,
                width: 14,
                height: 14,
                borderTop: `2px solid ${color}`,
                borderLeft: `2px solid ${color}`,
                borderRadius: 4,
              }}
            />
            <div
              style={{
                position: 'absolute',
                right: 7,
                top: 7,
                width: 14,
                height: 14,
                borderTop: `2px solid ${color}`,
                borderRight: `2px solid ${color}`,
                borderRadius: 4,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 7,
                bottom: 7,
                width: 14,
                height: 14,
                borderBottom: `2px solid ${color}`,
                borderLeft: `2px solid ${color}`,
                borderRadius: 4,
              }}
            />
            <div
              style={{
                position: 'absolute',
                right: 7,
                bottom: 7,
                width: 14,
                height: 14,
                borderBottom: `2px solid ${color}`,
                borderRight: `2px solid ${color}`,
                borderRadius: 4,
              }}
            />
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'grid',
                gridTemplateColumns: 'repeat(5, 1fr)',
                gridTemplateRows: 'repeat(5, 1fr)',
                gap: 2,
              }}
            >
              {Array.from({ length: 25 }).map((_, idx) => {
                const dark = ((idx * 7 + data.subtype.length) % 3) !== 1;
                return <div key={idx} style={{ background: dark ? color : '#fff', borderRadius: 1 }} />;
              })}
            </div>
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#f4f8ff' }}>{data.title}</div>
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
  const shifted = getShiftedPoints(
    sourceX,
    sourceY,
    targetX,
    targetY,
    data?.laneOffset ?? 0
  );
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: shifted.sourceX,
    sourceY: shifted.sourceY,
    targetX: shifted.targetX,
    targetY: shifted.targetY,
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

function buildBusinessSteps(nodes: SandboxNode[], edges: SandboxEdge[]) {
  if (edges.length === 0) {
    return [
      {
        id: 'step-empty-1',
        title: '步骤 1',
        desc: '添加渠道角色（总部、经销商、门店等）',
        status: 'done' as const,
      },
      {
        id: 'step-empty-2',
        title: '步骤 2',
        desc: '添加标识节点（物流码、营销二维码）',
        status: nodes.length > 0 ? ('done' as const) : ('active' as const),
      },
      {
        id: 'step-empty-3',
        title: '步骤 3',
        desc: '进入连线模式，点击两个节点建立业务关系',
        status: 'pending' as const,
      },
      {
        id: 'step-empty-4',
        title: '步骤 4',
        desc: '点击连线配置业务状态，形成完整演示链路',
        status: 'pending' as const,
      },
    ];
  }

  return edges.map((edge, index) => {
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    const sourceText = source ? getNodeDisplayText(source.data) : edge.source;
    const targetText = target ? getNodeDisplayText(target.data) : edge.target;
    return {
      id: edge.id,
      title: `步骤 ${index + 1}`,
      desc: `${sourceText} → ${targetText}：${edge.data?.linkState ?? '未配置'}`,
      status: 'done' as const,
    };
  });
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

function LeftPanelSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        borderRadius: 10,
        border: '1px solid rgba(120,148,206,0.25)',
        background: 'rgba(7,14,30,0.6)',
        padding: '10px 10px 8px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          fontSize: 12,
          color: '#9fc2ff',
          fontWeight: 600,
        }}
      >
        <span>{title}</span>
        {typeof count === 'number' ? (
          <span
            style={{
              fontSize: 10,
              color: '#c9dcff',
              borderRadius: 999,
              padding: '1px 7px',
              border: '1px solid rgba(120,148,206,0.35)',
              background: 'rgba(15,26,49,0.7)',
            }}
          >
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function ComponentToken({
  title,
  subtitle,
  onClick,
}: {
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap"
      style={{
        width: '100%',
        textAlign: 'left',
        borderRadius: 10,
        border: '1px solid rgba(120,148,206,0.3)',
        background: 'rgba(11,20,41,0.86)',
        padding: '8px 10px',
        color: '#e7f0ff',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 10, color: 'rgba(200,220,255,0.7)' }}>{subtitle}</div>
    </button>
  );
}

function GuideHintItem({
  index,
  text,
}: {
  index: number;
  text: string;
}) {
  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 9,
        padding: '8px 10px 8px 34px',
        border: '1px solid rgba(120,148,206,0.3)',
        background: 'rgba(12,22,44,0.7)',
        color: '#eaf2ff',
        fontSize: 11,
        lineHeight: 1.6,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 10,
          top: 8,
          width: 18,
          height: 18,
          borderRadius: 999,
          border: '1px solid rgba(120,148,206,0.45)',
          background: 'rgba(120,148,206,0.2)',
          display: 'grid',
          placeItems: 'center',
          fontSize: 10,
          fontWeight: 700,
          color: '#cae0ff',
        }}
      >
        {index}
      </div>
      {text}
    </div>
  );
}

const QUICK_GUIDE_STEPS = [
  'Shift + 框选：多选节点',
  'Delete / Backspace：删除选中内容',
  '按住空格 + 拖拽：平移无限画布',
];

const ADVANCED_GUIDE_STEPS = [
  '双击角色：编辑名称与区域',
  '双击标识：快速修改状态',
  '连线模式下依次点击两个节点建立关系',
];

const TOP_BAR_GUIDE_STEPS = [
  'Shift + 框选：多选',
  'Delete / Backspace：删除',
  '按住空格 + 拖拽：平移',
  '双击角色/标识：快速编辑',
];

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
    (sourceId: string, targetId: string, currentEdges: SandboxEdge[]) => {
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
          laneOffset: getBidirectionalLaneOffset(sourceId, targetId, currentEdges),
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

  const addRoleQuickly = useCallback(
    (option: RoleOption) => {
      setNodes((curr) => [
        ...curr,
        {
          id: createNodeId('role'),
          type: 'sandboxNode',
          draggable: true,
          position: calcNextPosition(curr, 'role'),
          data: {
            kind: 'role',
            family: option.family,
            subtype: option.subtype,
            title: option.subtype,
          },
        },
      ]);
    },
    [setNodes]
  );

  const addMarkQuickly = useCallback(
    (option: MarkOption) => {
      setNodes((curr) => [
        ...curr,
        {
          id: createNodeId('mark'),
          type: 'sandboxNode',
          draggable: true,
          position: calcNextPosition(curr, 'mark'),
          data: {
            kind: 'mark',
            family: option.family,
            subtype: option.subtype,
            title: option.subtype.replace('物流码', '').replace('营销码', '').replace('码', '码'),
            markState: '未入库',
          },
        },
      ]);
    },
    [setNodes]
  );

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
      setEdges((curr) => {
        const newEdge = buildEdge(pendingLinkSourceId, node.id, curr);
        if (!newEdge) return curr;

        const hasReverse = curr.some(
          (edge) => edge.source === node.id && edge.target === pendingLinkSourceId
        );
        const alignedCurrent = hasReverse
          ? curr.map((edge) =>
              edge.source === node.id && edge.target === pendingLinkSourceId
                ? {
                    ...edge,
                    data: { ...(edge.data as EdgeData), laneOffset: -26 },
                  }
                : edge
            )
          : curr;

        return addEdge(newEdge, alignedCurrent);
      });
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

  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: SandboxNode) => {
      setNodes((curr) =>
        curr.map((item) =>
          item.id === node.id
            ? {
                ...item,
                position: getSnappedPosition(node.id, node.position, curr),
              }
            : item
        )
      );
    },
    [setNodes]
  );

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
      if (event.key === 'Delete' || event.key === 'Backspace') {
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

  const roleNodes = useMemo(() => nodes.filter((node) => node.data.kind === 'role'), [nodes]);
  const markNodes = useMemo(() => nodes.filter((node) => node.data.kind === 'mark'), [nodes]);
  const businessSteps = useMemo(() => buildBusinessSteps(nodes, edges), [nodes, edges]);

  const sidePanelCardStyle: React.CSSProperties = {
    borderRadius: 10,
    border: '1px solid rgba(120,148,206,0.25)',
    background: 'rgba(7,14,30,0.62)',
    padding: '10px 10px 8px',
  };

  const sidePanelTitleStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    marginBottom: 6,
    color: '#9fc2ff',
    letterSpacing: 0.4,
  };

  return (
    <div
      style={{
        height: '100vh',
        width: '100%',
        background: '#060d1d',
        color: '#e7f0ff',
        display: 'grid',
        gridTemplateRows: '56px 1fr',
        gridTemplateColumns: '260px minmax(640px,1fr) 300px',
        gap: 10,
        padding: 10,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          gridColumn: '1 / 4',
          borderRadius: 10,
          border: '1px solid rgba(120,148,206,0.35)',
          background: 'rgba(7,14,30,0.86)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
        }}
      >
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>沙盘智能体</div>
          <div style={{ fontSize: 11, color: 'rgba(210,225,255,0.74)' }}>{summaryText}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
          {TOP_BAR_GUIDE_STEPS.map((step, index) => (
            <span
              key={step}
              style={{
                borderRadius: 999,
                border: '1px solid rgba(120,148,206,0.36)',
                background: 'rgba(10,18,36,0.76)',
                color: '#deebff',
                fontSize: 12,
                fontWeight: 600,
                padding: '7px 12px',
                whiteSpace: 'nowrap',
              }}
            >
              {index + 1}. {step}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ToolbarButton label="保存" onClick={saveLocal} />
          <ToolbarButton label="加载" onClick={loadLocal} />
          <ToolbarButton label="清空" onClick={clearAll} />
        </div>
      </div>

      <aside
        style={{
          borderRadius: 12,
          border: '1px solid rgba(120,148,206,0.3)',
          background: 'rgba(7,14,30,0.8)',
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          overflow: 'auto',
        }}
      >
        <div style={sidePanelCardStyle}>
          <div style={sidePanelTitleStyle}>快捷操作</div>
          <div style={{ display: 'grid', gap: 7 }}>
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
        </div>

        <div style={sidePanelCardStyle}>
          <div style={sidePanelTitleStyle}>组件库</div>
          <div style={{ fontSize: 11, color: 'rgba(210,225,255,0.72)', marginBottom: 8 }}>点击条目快速加点，支持重复添加</div>
          <LeftPanelSection title="角色节点" count={roleNodes.length}>
            <div style={{ display: 'grid', gap: 6 }}>
              {ALL_ROLE_OPTIONS.map((option) => (
                <ComponentToken
                  key={`left-role-${option.family}-${option.subtype}`}
                  title={option.subtype}
                  subtitle="角色"
                  onClick={() => addRoleQuickly(option)}
                />
              ))}
            </div>
          </LeftPanelSection>
          <div style={{ height: 8 }} />
          <LeftPanelSection title="标识节点" count={markNodes.length}>
            <div style={{ display: 'grid', gap: 6 }}>
              {ALL_MARK_OPTIONS.map((option) => (
                <ComponentToken
                  key={`left-mark-${option.family}-${option.subtype}`}
                  title={option.subtype}
                  subtitle="标识"
                  onClick={() => addMarkQuickly(option)}
                />
              ))}
            </div>
          </LeftPanelSection>
        </div>

        <div style={sidePanelCardStyle}>
          <div style={sidePanelTitleStyle}>快捷参考</div>
          <div
            style={{
              marginBottom: 8,
              borderRadius: 8,
              border: '1px dashed rgba(255,214,102,0.55)',
              background: 'rgba(255,214,102,0.08)',
              color: '#fff0c2',
              fontSize: 11,
              fontWeight: 700,
              padding: '6px 8px',
              letterSpacing: 0.2,
            }}
          >
            快速上手：建议按顺序试一遍
          </div>
          <div style={{ fontSize: 11, color: 'rgba(159,194,255,0.88)', marginBottom: 6, fontWeight: 700 }}>
            基础操作
          </div>
          <div style={{ display: 'grid', gap: 7 }}>
            {QUICK_GUIDE_STEPS.map((step, index) => (
              <GuideHintItem key={step} index={index + 1} text={step} />
            ))}
          </div>
          <div style={{ height: 10 }} />
          <div style={{ fontSize: 11, color: 'rgba(159,194,255,0.88)', marginBottom: 6, fontWeight: 700 }}>
            进阶操作
          </div>
          <div style={{ display: 'grid', gap: 7 }}>
            {ADVANCED_GUIDE_STEPS.map((step, index) => (
              <GuideHintItem key={step} index={index + 4} text={step} />
            ))}
          </div>
        </div>
      </aside>

      <main
        style={{
          borderRadius: 12,
          border: '1px solid rgba(120,148,206,0.3)',
          overflow: 'hidden',
          background: 'rgba(7,14,30,0.66)',
          position: 'relative',
        }}
      >
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
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={onSelectionChange}
          onPaneClick={() => {
            if (toolMode === 'link') setPendingLinkSourceId(null);
          }}
          fitView
          selectionOnDrag={false}
          selectionKeyCode="Shift"
          panOnDrag={spacePressed}
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode="Shift"
          deleteKeyCode={null}
          attributionPosition="bottom-right"
          snapGrid={SNAP_GRID}
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
      </main>

      <aside
        style={{
          borderRadius: 12,
          border: '1px solid rgba(120,148,206,0.3)',
          background: 'rgba(7,14,30,0.8)',
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          overflow: 'auto',
        }}
      >
        <div style={sidePanelCardStyle}>
          <div style={sidePanelTitleStyle}>解析与检验</div>
          <div style={{ display: 'grid', gap: 8, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(210,225,255,0.72)' }}>当前模式</span>
              <span style={{ color: '#d8e7ff', fontWeight: 600 }}>{toolMode === 'link' ? '连线' : '自由搭建'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(210,225,255,0.72)' }}>节点总数</span>
              <span style={{ color: '#d8e7ff', fontWeight: 600 }}>{nodes.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(210,225,255,0.72)' }}>连线总数</span>
              <span style={{ color: '#d8e7ff', fontWeight: 600 }}>{edges.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(210,225,255,0.72)' }}>连线状态</span>
              <span style={{ color: pendingLinkSourceId ? '#ffd88b' : '#a4c2ff', fontWeight: 600 }}>
                {pendingLinkSourceId ? '等待终点' : '待命'}
              </span>
            </div>
          </div>
        </div>

        <div style={sidePanelCardStyle}>
          <div style={sidePanelTitleStyle}>业务步骤说明</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {businessSteps.map((step) => {
              const bg =
                step.status === 'done'
                  ? 'rgba(36, 174, 116, 0.18)'
                  : step.status === 'active'
                    ? 'rgba(253, 185, 74, 0.2)'
                    : 'rgba(120,148,206,0.14)';
              const border =
                step.status === 'done'
                  ? '1px solid rgba(72, 207, 147, 0.42)'
                  : step.status === 'active'
                    ? '1px solid rgba(253, 185, 74, 0.45)'
                    : '1px solid rgba(120,148,206,0.3)';
              const tag = step.status === 'done' ? '完成' : step.status === 'active' ? '进行中' : '排队中';
              return (
                <div key={step.id} style={{ borderRadius: 10, border, background: bg, padding: '8px 10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>{step.title}</span>
                    <span style={{ fontSize: 10, color: 'rgba(225,238,255,0.82)' }}>{tag}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(210,225,255,0.82)', lineHeight: 1.6 }}>{step.desc}</div>
                </div>
              );
            })}
          </div>
        </div>
      </aside>

      {showRoleMenu ? (
        <div
          style={{
            position: 'absolute',
            left: 278,
            top: 78,
            zIndex: 30,
            width: 318,
            maxHeight: 420,
            overflow: 'auto',
            borderRadius: 12,
            border: '1px solid rgba(120,148,206,0.35)',
            background: 'rgba(6,12,28,0.98)',
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
            left: 278,
            top: 78,
            zIndex: 30,
            width: 318,
            maxHeight: 420,
            overflow: 'auto',
            borderRadius: 12,
            border: '1px solid rgba(120,148,206,0.35)',
            background: 'rgba(6,12,28,0.98)',
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
