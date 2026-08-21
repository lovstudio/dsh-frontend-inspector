# @deepseek-ai/dsh-frontend-inspector

DeepSeek Harness 前端插件：**点击跳转源码**（基于 LovInsp）。浏览器中按住 `Shift + Option` 点击页面元素，直接在编辑器中打开对应源码位置。

## 功能

- 浏览器点击元素 → 打开 IDE 定位到源码（`file:line:column`）
- 设置界面 `frontend-inspector.enabled` 开关门控注入
- IDE bridge 由插件运行时启动，release 构建（`dsh web`）同样可用

## 安装

插件以 **bundle** 形式安装到 DeepSeek Harness profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-frontend-inspector
```

安装后在浏览器「设置 → 插件 → 插件配置」打开「前端检查器」的 `启用` 开关。

## 使用

按住 `Shift + Option`，点击页面任意元素 → 编辑器自动打开对应源码。

## 架构

完整实现位于 `deepseek-harness` monorepo：`packages/core/frontend-inspector`（host：settings 开关 + IDE bridge + `/lovinsp-inject.js` 路由 + index tap）与 `scripts/frontend-inspector.ts`（构建期 `data-insp-path` 标记）。本仓库为独立展示与发布入口，源码主仓：

- 上游：https://github.com/deepseek-ai/deepseek-harness
- 完整代码（含本插件）：https://github.com/lovstudio/deepseek-harness

## License

MIT
