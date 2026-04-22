import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

// Docker 容器中使用系统 Chromium，跳过 Remotion 自动下载流程
// 本地开发不设置此变量，Remotion 使用自己下载的 Chromium
if (process.env.CHROMIUM_EXECUTABLE_PATH) {
  Config.setChromiumExecutablePath(process.env.CHROMIUM_EXECUTABLE_PATH);
}
