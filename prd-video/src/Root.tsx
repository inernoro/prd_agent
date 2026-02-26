import { Composition } from "remotion";
import { TutorialVideo } from "./TutorialVideo";
import type { VideoData } from "./types";

/** 默认 props（用于 Studio 预览） */
const defaultProps: VideoData = {
  title: "云开发入门教程",
  fps: 30,
  width: 1920,
  height: 1080,
  scenes: [
    {
      index: 0,
      topic: "什么是云开发",
      narration: "大家好，今天我们来了解云开发的核心概念，以及它如何改变现代应用开发方式。",
      visualDescription: "标题动画 + 云计算图标",
      durationSeconds: 10,
      durationInFrames: 300,
      sceneType: "intro",
    },
    {
      index: 1,
      topic: "云开发的核心优势",
      narration: "云开发让开发者无需关心服务器运维，专注于业务逻辑。它提供数据库、存储、云函数等一站式后端服务。",
      visualDescription: "优势列表卡片",
      durationSeconds: 12,
      durationInFrames: 360,
      sceneType: "concept",
    },
    {
      index: 2,
      topic: "快速上手三步走",
      narration: "第一步，创建云开发环境。第二步，初始化项目配置。第三步，部署你的第一个云函数。",
      visualDescription: "步骤流程图",
      durationSeconds: 10,
      durationInFrames: 300,
      sceneType: "steps",
    },
    {
      index: 3,
      topic: "云函数示例代码",
      narration: "这是一个简单的云函数示例，它接收请求参数并返回处理结果。使用 exports.main 导出函数入口。",
      visualDescription: "代码块展示",
      durationSeconds: 12,
      durationInFrames: 360,
      sceneType: "code",
    },
    {
      index: 4,
      topic: "传统开发 vs 云开发",
      narration: "传统开发需要自行搭建服务器、配置数据库、处理运维。云开发则将这些全部托管，开箱即用。",
      visualDescription: "对比卡片",
      durationSeconds: 10,
      durationInFrames: 300,
      sceneType: "comparison",
    },
    {
      index: 5,
      topic: "总结与展望",
      narration: "云开发大幅降低了开发门槛。掌握云开发，你就拥有了全栈开发的能力。希望本教程对你有所帮助，感谢观看！",
      visualDescription: "总结要点列表",
      durationSeconds: 10,
      durationInFrames: 300,
      sceneType: "outro",
    },
  ],
};

/** 计算总帧数 */
function getTotalFrames(scenes: VideoData["scenes"]): number {
  return scenes.reduce((sum, s) => sum + s.durationInFrames, 0);
}

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TutorialVideo"
        component={TutorialVideo}
        durationInFrames={getTotalFrames(defaultProps.scenes)}
        fps={defaultProps.fps}
        width={defaultProps.width}
        height={defaultProps.height}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => {
          return {
            durationInFrames: getTotalFrames(props.scenes),
            fps: props.fps,
            width: props.width,
            height: props.height,
          };
        }}
      />
    </>
  );
};
