/**
 * 会议开场模板
 * 适用场景：年度大会、发布会、峰会等活动的开场视频
 */
import { z } from 'zod';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
  Img,
} from 'remotion';
import { TemplateDefinition, FieldMeta } from '../types';

// ============ Schema 定义 ============

const speakerSchema = z.object({
  name: z.string().min(1, '姓名不能为空'),
  title: z.string().optional(),        // 职位
  avatar: z.string().optional(),       // 头像 URL
  tagline: z.string().optional(),      // 个人标语
});

type Speaker = z.infer<typeof speakerSchema>;

export const conferenceOpeningSchema = z.object({
  // 活动信息
  eventName: z.string().min(1, '活动名称不能为空'),
  eventSubtitle: z.string().optional(),
  eventDate: z.string().optional(),

  // 品牌
  logoUrl: z.string().optional(),
  companyName: z.string().optional(),

  // 演讲者
  speakers: z.array(speakerSchema).max(6, '最多支持6位演讲者'),

  // 视觉风格
  primaryColor: z.string().default('#6366f1'),
  secondaryColor: z.string().default('#ec4899'),
  backgroundColor: z.string().default('#0f172a'),

  // 文案
  welcomeText: z.string().default('欢迎参加'),
  closingText: z.string().default('精彩即将开始'),
});

export type ConferenceOpeningProps = z.infer<typeof conferenceOpeningSchema>;

// ============ 字段元数据 ============

export const conferenceOpeningFieldMeta: Record<string, FieldMeta> = {
  eventName: {
    label: '活动名称',
    description: '活动的主标题',
    placeholder: '例如：2026年度用户大会',
    type: 'text',
    group: '活动信息',
  },
  eventSubtitle: {
    label: '活动副标题',
    placeholder: '例如：创新引领未来',
    type: 'text',
    group: '活动信息',
  },
  eventDate: {
    label: '活动日期',
    placeholder: '例如：2026年3月15日',
    type: 'text',
    group: '活动信息',
  },
  logoUrl: {
    label: '公司 Logo',
    description: '支持 PNG/SVG 格式',
    placeholder: 'https://example.com/logo.png',
    type: 'image',
    group: '品牌',
  },
  companyName: {
    label: '公司名称',
    placeholder: '例如：ABC 科技',
    type: 'text',
    group: '品牌',
  },
  speakers: {
    label: '演讲嘉宾',
    description: '添加演讲者信息（最多6位）',
    type: 'array',
    group: '嘉宾',
    arrayItemSchema: speakerSchema,
    arrayItemFields: {
      name: { label: '姓名', type: 'text', placeholder: '张三' },
      title: { label: '职位', type: 'text', placeholder: 'CEO' },
      avatar: { label: '头像', type: 'image', placeholder: 'https://...' },
      tagline: { label: '标语', type: 'text', placeholder: '引领创新' },
    },
  },
  primaryColor: {
    label: '主色调',
    type: 'color',
    group: '视觉风格',
  },
  secondaryColor: {
    label: '副色调',
    type: 'color',
    group: '视觉风格',
  },
  backgroundColor: {
    label: '背景色',
    type: 'color',
    group: '视觉风格',
  },
  welcomeText: {
    label: '欢迎语',
    type: 'text',
    group: '文案',
  },
  closingText: {
    label: '结束语',
    type: 'text',
    group: '文案',
  },
};

// ============ 组件实现 ============

// 粒子背景
function ParticleBackground({ color }: { color: string }) {
  const frame = useCurrentFrame();
  const particles = Array.from({ length: 30 }, (_, i) => {
    const x = (i * 37 + frame * 0.3) % 100;
    const y = (i * 23 + frame * 0.2) % 100;
    const size = (i % 3) + 2;
    const opacity = 0.1 + (i % 5) * 0.1;

    return (
      <div
        key={i}
        style={{
          position: 'absolute',
          left: `${x}%`,
          top: `${y}%`,
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: color,
          opacity,
        }}
      />
    );
  });

  return <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>{particles}</div>;
}

// 网格背景
function GridBackground({ color }: { color: string }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 0.15], { extrapolateRight: 'clamp' });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        opacity,
        backgroundImage: `
          linear-gradient(${color}40 1px, transparent 1px),
          linear-gradient(90deg, ${color}40 1px, transparent 1px)
        `,
        backgroundSize: '60px 60px',
      }}
    />
  );
}

// 扫光效果
function ScanLine({ color }: { color: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const scanX = interpolate(frame, [0, durationInFrames * 0.6], [-20, 120], {
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `linear-gradient(90deg,
          transparent ${scanX - 15}%,
          ${color}20 ${scanX - 5}%,
          ${color}40 ${scanX}%,
          ${color}20 ${scanX + 5}%,
          transparent ${scanX + 15}%
        )`,
        pointerEvents: 'none',
      }}
    />
  );
}

// 开场场景
function OpeningScene({ props }: { props: ConferenceOpeningProps }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({ frame, fps, config: { damping: 12, stiffness: 100 } });
  const logoOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });

  const welcomeOpacity = interpolate(frame, [20, 35], [0, 1], { extrapolateRight: 'clamp' });
  const welcomeY = interpolate(frame, [20, 35], [30, 0], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 30,
      }}
    >
      {/* Logo */}
      {props.logoUrl && (
        <div style={{ opacity: logoOpacity, transform: `scale(${logoScale})` }}>
          <Img
            src={props.logoUrl}
            style={{ width: 120, height: 120, objectFit: 'contain' }}
          />
        </div>
      )}

      {/* 欢迎语 */}
      <div
        style={{
          opacity: welcomeOpacity,
          transform: `translateY(${welcomeY}px)`,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 28,
            color: props.primaryColor,
            marginBottom: 10,
            letterSpacing: 4,
          }}
        >
          {props.welcomeText}
        </div>
        <h1
          style={{
            fontSize: 72,
            fontWeight: 'bold',
            color: '#ffffff',
            margin: 0,
            textShadow: `0 0 40px ${props.primaryColor}60`,
          }}
        >
          {props.eventName}
        </h1>
        {props.eventSubtitle && (
          <div
            style={{
              fontSize: 32,
              color: '#94a3b8',
              marginTop: 15,
            }}
          >
            {props.eventSubtitle}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

// 演讲者展示场景
function SpeakersScene({ props }: { props: ConferenceOpeningProps }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!props.speakers || props.speakers.length === 0) {
    return null;
  }

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 60,
      }}
    >
      <h2
        style={{
          fontSize: 36,
          color: props.primaryColor,
          marginBottom: 50,
          opacity: interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' }),
        }}
      >
        演讲嘉宾
      </h2>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 40,
          maxWidth: 1400,
        }}
      >
        {props.speakers.map((speaker: Speaker, index: number) => {
          const delay = index * 8;
          const scale = spring({
            frame: frame - delay,
            fps,
            config: { damping: 12, stiffness: 100 },
          });
          const opacity = interpolate(frame - delay, [0, 15], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });

          return (
            <div
              key={index}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                opacity,
                transform: `scale(${Math.max(0, scale)})`,
              }}
            >
              {/* 头像 */}
              <div
                style={{
                  width: 120,
                  height: 120,
                  borderRadius: '50%',
                  background: speaker.avatar
                    ? `url(${speaker.avatar}) center/cover`
                    : `linear-gradient(135deg, ${props.primaryColor}, ${props.secondaryColor})`,
                  border: `3px solid ${props.primaryColor}`,
                  marginBottom: 15,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 48,
                  color: '#fff',
                }}
              >
                {!speaker.avatar && speaker.name.charAt(0)}
              </div>

              {/* 名字 */}
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 'bold',
                  color: '#ffffff',
                }}
              >
                {speaker.name}
              </div>

              {/* 职位 */}
              {speaker.title && (
                <div
                  style={{
                    fontSize: 16,
                    color: '#94a3b8',
                    marginTop: 5,
                  }}
                >
                  {speaker.title}
                </div>
              )}

              {/* 标语 */}
              {speaker.tagline && (
                <div
                  style={{
                    fontSize: 14,
                    color: props.primaryColor,
                    marginTop: 8,
                    fontStyle: 'italic',
                  }}
                >
                  "{speaker.tagline}"
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

// 结束场景
function ClosingScene({ props }: { props: ConferenceOpeningProps }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const textOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  const textScale = spring({ frame, fps, config: { damping: 15, stiffness: 80 } });

  const fadeOut = interpolate(frame, [durationInFrames - 30, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        opacity: fadeOut,
      }}
    >
      <div
        style={{
          opacity: textOpacity,
          transform: `scale(${textScale})`,
          textAlign: 'center',
        }}
      >
        <h2
          style={{
            fontSize: 56,
            fontWeight: 'bold',
            color: '#ffffff',
            margin: 0,
            textShadow: `0 0 60px ${props.primaryColor}`,
          }}
        >
          {props.closingText}
        </h2>

        {props.eventDate && (
          <div
            style={{
              fontSize: 28,
              color: props.primaryColor,
              marginTop: 30,
            }}
          >
            {props.eventDate}
          </div>
        )}

        {props.companyName && (
          <div
            style={{
              fontSize: 20,
              color: '#64748b',
              marginTop: 40,
              letterSpacing: 2,
            }}
          >
            {props.companyName}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

// 主组件
export function ConferenceOpening(props: ConferenceOpeningProps) {
  const { durationInFrames } = useVideoConfig();

  // 计算场景时长
  const hasSpeakers = props.speakers && props.speakers.length > 0;
  const openingDuration = Math.floor(durationInFrames * 0.35);
  const speakersDuration = hasSpeakers ? Math.floor(durationInFrames * 0.4) : 0;
  const closingDuration = durationInFrames - openingDuration - speakersDuration;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: props.backgroundColor,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* 背景层 */}
      <ParticleBackground color={props.primaryColor} />
      <GridBackground color={props.primaryColor} />
      <ScanLine color={props.secondaryColor} />

      {/* 场景层 */}
      <Sequence from={0} durationInFrames={openingDuration}>
        <OpeningScene props={props} />
      </Sequence>

      {hasSpeakers && (
        <Sequence from={openingDuration} durationInFrames={speakersDuration}>
          <SpeakersScene props={props} />
        </Sequence>
      )}

      <Sequence from={openingDuration + speakersDuration} durationInFrames={closingDuration}>
        <ClosingScene props={props} />
      </Sequence>
    </AbsoluteFill>
  );
}

// ============ 模板定义导出 ============

export const conferenceOpeningTemplate: TemplateDefinition<typeof conferenceOpeningSchema> = {
  id: 'conference-opening',
  name: '会议开场',
  description: '适用于年度大会、发布会、峰会等活动的开场视频，支持展示演讲嘉宾',
  category: 'conference',
  thumbnail: undefined,

  schema: conferenceOpeningSchema,
  defaultProps: {
    eventName: '2026年度用户大会',
    eventSubtitle: '创新引领未来',
    eventDate: '2026年3月15日',
    logoUrl: '',
    companyName: '',
    speakers: [],
    primaryColor: '#6366f1',
    secondaryColor: '#ec4899',
    backgroundColor: '#0f172a',
    welcomeText: '欢迎参加',
    closingText: '精彩即将开始',
  },
  fieldMeta: conferenceOpeningFieldMeta,

  component: ConferenceOpening,

  defaultDuration: 10,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],

  aiPromptHint: `这是一个会议/活动开场视频模板。用户可能会说：
- "为我们公司年度大会做开场视频"
- "做一个发布会的片头，有3位演讲者"
- "创建一个峰会开场，展示CEO和CTO"
你需要从用户描述中提取：活动名称、演讲者信息（姓名、职位）、日期、公司名等。`,

  exampleUserInput: '为我们公司年度用户大会做开场视频，有张三CEO、李四CTO、王五CFO三位演讲者，主题是"AI赋能未来"',
};
