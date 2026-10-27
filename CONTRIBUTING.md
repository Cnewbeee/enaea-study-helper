# 贡献指南

感谢你愿意改进这个项目。提交代码前请先阅读以下约定。

## 项目结构

```text
extension/        Chrome/Edge 扩展（弹窗确认 + 自动连播）
userscript/       Tampermonkey 油猴脚本（仅弹窗确认）
python/           Playwright 版弹窗确认脚本
test/             Playwright 模拟页面测试
.github/          CI、Issue/PR 模板
```

## 本地开发

### 扩展

1. 打开 `edge://extensions/` 或 `chrome://extensions/`。
2. 开启“开发人员模式”。
3. “加载解压缩的扩展”，选择 `extension` 目录。
4. 修改代码后，点扩展卡片上的“重新加载”。
5. **重新加载扩展后，课程列表页和播放页都要刷新一次**，否则旧页面里的内容脚本会失效。

### 测试

```bash
# JavaScript 语法
node --check extension/background.js
node --check extension/course-auto.js
node --check extension/content.js
node --check extension/main-world.js

# 弹窗确认模拟测试
pip install -r python/requirements.txt
python -m playwright install chromium
python test/run_test.py
```

## 代码约定

- 使用 2 空格缩进（Python 4 空格）。
- 不引入构建工具；扩展保持原生 Manifest V3。
- 新增页面适配时，优先使用 `courseId` / `courseid-id` / `data-vurl` 等稳定属性，避免依赖容易变化的样式。
- 所有自动化点击都必须有冷却或次数上限，避免反复误点。
- 修改 `content.js` 的弹窗识别逻辑时，务必保留对“退出学习、提交、交卷、删除”等危险按钮的排除。

## 隐私与安全

- **不要**提交账号、密码、Cookie、Token、课程 ID、带个人信息的截图或日志。
- 扩展只应在 `*.enaea.edu.cn` 上运行；不要扩大权限而不说明原因。
- 新增网络请求前请在 PR 中说明用途；本项目默认不向任何服务器发送学习数据。
- 发现安全问题请不要公开提 Issue，使用 GitHub 的 Security Advisory 私密报告。

## 提交 PR

- 一个 PR 尽量只做一件事。
- 说明改动原因、测试方式和已知限制。
- 如果适配了新的页面结构，请附上脱敏后的 DOM 片段或诊断信息。
