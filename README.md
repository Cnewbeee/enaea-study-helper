# ENAEAA 学习助手（弹窗确认 + 自动连播）

[![CI](https://github.com/Cnewbeee/enaea-study-helper/actions/workflows/ci.yml/badge.svg)](https://github.com/Cnewbeee/enaea-study-helper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4.svg)](extension/manifest.json)

> 代码仓库：<https://github.com/Cnewbeee/enaea-study-helper>

针对 `https://study.enaea.edu.cn/viewerforccvideo.do?courseId=...&circleId=...` 这类课程视频页面：

- 观看约 20 分钟后出现“继续学习 / 继续观看 / 确定”确认框时，自动点击；
- 点击后尝试自动恢复视频播放；
- 同时处理浏览器原生的 `confirm` / `alert` 弹窗；
- 会避开“退出学习、提交试卷、交卷、删除”等危险按钮；
- **v2.0 新增**：自动识别当前分集进度、显示剩余时间、自动续播上次分集、自动切换下一集，整门课程结束后自动从“全部课程”标签页打开下一门课程。

| 功能 | 扩展 | 油猴 | Python |
| --- | :---: | :---: | :---: |
| 自动确认“继续学习”弹窗 | ✅ | ✅ | ✅ |
| 自动续播上次分集 | ✅ | — | — |
| 自动下一集 | ✅ | — | — |
| 整门课程结束后自动下一门 | ✅ | — | — |
| 左下角状态面板 / 诊断 | ✅ | — | — |

> 自动连播（自动续播、下一集、下一门课程）目前只在 **Chrome/Edge 扩展** 中实现；油猴脚本和 Python 版仍然只负责弹窗确认。

---

## 自动连播（v2.0）

扩展会在课程页面左下角显示一个常驻面板：

```
ENAEAA 自动连播
第 2/6 集 · 剩余 06:37
进度 42% · 已完成 1/6 集
下一集：第三集 积极扩大自主开放
检查于 12:30:41
```

行为说明：

1. **每 2 秒检查一次**当前分集进度和剩余时间；后台另有 30 秒一次的兜底检查。
2. **自动续播**：刷新或重新进入课程后，如果站点从第一集开始，扩展会自动点回上次“已看了一部分”的分集；如果视频从 0 秒开始，会跳到该分集上次观看的百分比位置。
3. **自动下一集**：当前分集进度到 100%（或视频播放结束）时，自动点击下一集并恢复播放。
4. **自动下一门课程**：当前课程的所有分集都完成后，扩展会到另一个“全部课程”标签页里，按当前课程的 `courseId` 找到下一门课程，并直接打开。
5. **暂停/恢复**：面板右上角可以暂停监控；暂停后不会自动点击。
6. **诊断**：点面板上的“诊断”（或按 `Ctrl+Shift+D`）会把当前页面结构、分集、课程列表复制到剪贴板，方便排查页面改版。

### 使用条件

- 浏览器里保持 **两个标签页**：
  1. 一个“全部课程/我的课程”列表页；
  2. 一个正在播放的课程页。
- 浏览器（Edge/Chrome）需要保持打开；关闭浏览器后自动连播停止。
- 只对 `*.enaea.edu.cn` 生效。
- 如果扩展重新加载过，**两个标签页都要刷新一次**，否则旧标签页里的脚本会失效。

### 安装/更新

1. 打开 `edge://extensions/` 或 `chrome://extensions/`。
2. 打开 **开发人员模式**。
3. 首次安装：点 **加载解压缩的扩展**，选择 `extension` 目录。
4. 已安装过：点扩展卡片上的 **重新加载**。
5. 重新加载扩展后，先刷新“全部课程”标签页，再刷新课程播放页。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| 面板显示“本页识别到 0 门课程” | 刷新“全部课程”标签页；确认列表已经加载出课程 |
| 刷新后仍从第一集开始 | 等 3–5 秒，扩展会自动点回上次分集；若没有，点一下“诊断”把信息发给助手 |
| 不自动切下一门课程 | 确认“全部课程”标签页仍然打开，并且停留在课程列表 |
| 面板显示“切换失败” | 手动点下一门课程；检查列表页是否被关闭或跳到了其他页面 |
| 视频暂停不动 | 点一下视频播放按钮；浏览器的自动播放策略可能阻止了脚本恢复播放 |

---

## 方案一：Chrome / Edge 扩展（推荐）


### 安装

1. 打开 Chrome 的 `chrome://extensions/`，或 Edge 的 `edge://extensions/`。
2. 打开右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**（Edge 为“加载解压缩的扩展”）。
4. 选择本文件夹里的 **`extension`** 目录（不是整个 `enaea-auto-confirm`）。
5. 确认扩展列表中出现“ENAEAA 学习助手（弹窗确认 + 自动连播）”，并处于启用状态。
6. 重新打开/刷新课程视频页面。

安装后不需要做其他操作，脚本会自动运行。

### 验证是否生效

1. 在视频页面按 `F12` 打开开发者工具，切到 **Console（控制台）**。
2. 看到下面这行日志说明已启用：

   ```
   [enaea-auto] 已启用，正在等待学习弹窗…
   ```

3. 弹窗被点击时会出现：

   ```
   [enaea-auto] 点击弹窗按钮： 继续学习
   ```

### 修改按钮文字

如果实际弹窗按钮不是“继续学习”，而是“我知道了”“确认”等，可编辑：

`extension/content.js`

文件顶部有 `CONFIG`：

```js
strongTexts: ['继续学习', '继续观看', '继续播放', '确认继续'],
weakTexts: ['继续', '确定', '确认', '知道了', '我知道了', '好的'],
```

- `strongTexts`：弹窗里出现这些文字就直接点；
- `weakTexts`：需要弹窗内容包含“学习/观看/分钟”等关键词才点。

改完后：

1. 打开 `chrome://extensions/`；
2. 点击扩展卡片上的 **刷新** 图标；
3. 刷新课程页面。

---

## 方案二：Tampermonkey 脚本

> 该脚本只包含弹窗确认，不包含 v2.0 的自动续播/自动下一门课程。

1. 在 Chrome/Edge 安装 **Tampermonkey** 扩展。
2. 打开 Tampermonkey 管理面板 → **添加新脚本**。
3. 用记事本打开 `userscript/enaea-auto-confirm.user.js`，全选复制，粘贴覆盖编辑器里的内容，保存。
4. 刷新课程视频页面。
5. 在 Tampermonkey 面板确认该脚本处于启用状态。

脚本已经包含原生 `confirm` 处理。配置同样在文件顶部的 `CONFIG` 中（搜索 `strongTexts`），修改后按 `Ctrl+S` 保存并刷新页面。

---

## 方案三：Python + Playwright

> 该方案只负责弹窗确认，不包含 v2.0 的自动续播/自动下一门课程。

### 安装

```powershell
cd enaea-auto-confirm
pip install -r python/requirements.txt
```

本机已安装 Chrome 时不需要额外下载浏览器。

### 运行

```powershell
python python/enaea_auto_confirm.py --url "https://study.enaea.edu.cn/viewerforccvideo.do?courseId=你的课程ID&circleId=你的班级ID"
```

也可以先设置环境变量 `ENAEA_COURSE_URL`，再直接运行脚本。

- 会打开一个受脚本控制的 Chrome 窗口；
- **首次运行请在窗口里手动登录**，登录状态会保存在独立配置目录中；
- 登录后打开课程视频页面，保持终端和浏览器运行；
- 按 `Ctrl+C` 停止。

常用参数：

```powershell
python python/enaea_auto_confirm.py --url "课程视频地址"
python python/enaea_auto_confirm.py --profile "D:\某个目录\enaea-profile"
```

脚本会读取 `extension/content.js` 中的点击逻辑，所以请保留目录结构。

> Playwright 打开的是独立配置的 Chrome，不会使用你日常 Chrome 的登录状态，这是正常现象。

---

## 配置说明（扩展 / 油猴脚本）

在 `extension/content.js` 顶部：

| 配置 | 作用 |
| --- | --- |
| `strongTexts` | 高置信度按钮文字，弹窗内出现即点击 |
| `weakTexts` | 普通确认文字，需配合弹窗关键词 |
| `popupKeywords` | 用来识别“学习提醒”弹窗的词 |
| `blockKeywords` | 弹窗含这些词时不点普通“确定”，防止退出/交卷 |
| `autoResume` | 点击后是否自动恢复视频播放 |
| `dryRun` | `true` 时只打印日志、不实际点击，用于调试 |
| `debug` | 是否输出 `[enaea-auto]` 日志 |

示例：只想在“继续学习”按钮出现时点击，可以把 `weakTexts` 改为空数组：

```js
weakTexts: [],
```

---

## 常见问题

### 1. 弹窗出现了但没被点击

先看 Console 有没有 `[enaea-auto]` 日志。

- **没有日志**：扩展没加载成功，或页面域名不是 `enaea.edu.cn`。确认扩展已启用，并刷新页面。
- **有日志但不点击**：弹窗按钮文字和配置不一致。右键点击弹窗按钮 → **检查**，查看按钮文字，把文字加到 `strongTexts`，然后刷新扩展和页面。
- **弹窗在 iframe 中**：扩展默认只匹配 `enaea.edu.cn`。在开发者工具 Elements 面板查看 iframe 的地址；如果是不属于 `enaea.edu.cn` 的域名，需要把该域名加入 `extension/manifest.json` 的 `matches`（两处都要加），或改用 Python 版。
- **弹窗被识别为无关弹窗**：把 `dryRun` 改为 `true`，刷新后看 Console 是否打印“本应点击”；如果弹窗内容里有“退出/提交”等词，可能被 `blockKeywords` 拦截，可按需调整。

### 2. 视频没有自动恢复播放

v2.0 扩展会先尝试点击站点自己的播放按钮，再调用 `video.play()`；如果浏览器拦截带声音的自动播放，扩展会**静音后重试**。看到面板提示“已静音自动播放”时，点一下视频的音量按钮即可恢复声音。

油猴/Python 版只在点击弹窗后尝试恢复播放，不会影响你主动暂停的视频。

### 3. 浏览器后台标签页不点击

Chrome 会节流后台标签页的定时器。建议让课程视频标签页保持在前台。弹窗出现后即使延迟几十秒才点击，通常也不影响。

### 4. 改了代码没生效

- 扩展：`chrome://extensions/` → 点击扩展卡片上的刷新按钮 → 刷新课程页面。
- 油猴：在编辑器中 `Ctrl+S` 保存 → 刷新课程页面。

### 5. 是否会被平台检测

脚本只是模拟点击页面按钮，不修改视频播放进度，也不调用平台接口。但平台规则是否允许自动化操作由平台决定，请自行判断并承担风险。

---

## 目录结构

```
enaea-auto-confirm/
├─ extension/                 # Chrome/Edge 扩展（推荐）
│  ├─ manifest.json
│  ├─ background.js           # 后台：查找课程列表、切换下一门课程、30 秒兜底检查
│  ├─ course-auto.js          # 自动续播/下一集/下一门 + 左下角面板
│  ├─ main-world.js           # 处理原生 confirm/alert
│  └─ content.js              # 弹窗检测与点击（核心配置在这里）
├─ userscript/
│  └─ enaea-auto-confirm.user.js
├─ python/
│  ├─ enaea_auto_confirm.py
│  └─ requirements.txt
├─ test/
│  ├─ mock.html               # 本地模拟弹窗页
│  ├─ frame.html              # iframe 弹窗测试页
│  ├─ run_test.py             # 核心逻辑自动化测试
│  └─ e2e_extension.py        # 加载扩展的端到端测试（会打开浏览器窗口）
├─ .github/workflows/ci.yml   # GitHub Actions：语法检查 + 弹窗模拟测试
├─ build_userscript.py        # 由 content.js 重新生成油猴脚本
├─ CHANGELOG.md
├─ CONTRIBUTING.md
├─ SECURITY.md
├─ LICENSE
└─ README.md
```

开发自测：

```powershell
python test/run_test.py
```

CI 还会执行：

```bash
node --check extension/background.js
node --check extension/course-auto.js
node --check extension/content.js
node --check extension/main-world.js
```

修改 `extension/content.js` 后，如果要同步更新油猴脚本，运行：

```powershell
python build_userscript.py
```

---

## 免责声明

本工具仅用于减少重复点击、方便个人学习。请遵守平台用户协议和相关规定，不要用于代刷课时、作弊或其他违规用途。使用产生的账号或学习记录风险由使用者自行承担。

## License

本项目采用 [MIT License](LICENSE)。Copyright (c) 2026 Cnewbeee.
