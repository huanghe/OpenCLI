# 安装

## 系统要求

- **Node.js**: >= 21.0.0，或 **Bun** >= 1.0
- **Chrome** 已运行并登录目标网站（浏览器命令需要）

## 通过 npm 安装（推荐）

```bash
npm install -g @jackwener/opencli
```

## 安装 Browser Bridge 扩展

使用浏览器命令前，推荐从 [Chrome Web Store](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk) 安装 **OpenCLI** 扩展。手动安装方式和验证步骤见 [Browser Bridge 设置](./browser-bridge)。

## 从源码安装

```bash
git clone git@github.com:jackwener/opencli.git
cd opencli
npm install
npm run build
npm link
opencli list
```

## 更新

```bash
npm install -g @jackwener/opencli@latest

# 如果你在用打包发布的 OpenCLI skills，也一起刷新
npx skills add jackwener/opencli
```

如果你只装了部分 skill，也可以只刷新自己在用的：

```bash
npx skills add jackwener/opencli --skill opencli-adapter-author
npx skills add jackwener/opencli --skill opencli-autofix
npx skills add jackwener/opencli --skill opencli-browser
npx skills add jackwener/opencli --skill opencli-usage
npx skills add jackwener/opencli --skill smart-search
```

## 验证安装

```bash
opencli --version
opencli list
opencli doctor
```
