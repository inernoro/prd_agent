import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

// Docker 容器中使用系统 Chromium，跳过 Remotion 自动下载流程
// 本地开发不设置此变量，Remotion 使用自己下载的 Chromium
// 注意：Remotion 4.x 的 API 是 setBrowserExecutable，不是 setChromiumExecutablePath
if (process.env.CHROMIUM_EXECUTABLE_PATH) {
  Config.setBrowserExecutable(process.env.CHROMIUM_EXECUTABLE_PATH);
}
