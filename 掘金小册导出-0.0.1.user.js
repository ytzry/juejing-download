// ==UserScript==
// @name         掘金小册导出
// @namespace    https://github.com/ytzry
// @version      0.2.0
// @description  一键导出掘金小册，支持多线程并发下载图片
// @author       ytzry
// @match        https://juejin.cn/book/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  var svgDownloadBtn = `<svg version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" height="24" width="24"
    viewBox="0 0 477.867 477.867" style="fill:%color;" xml:space="preserve">
    <g><path d="M443.733,307.2c-9.426,0-17.067,7.641-17.067,17.067v102.4c0,9.426-7.641,17.067-17.067,17.067H68.267
                 c-9.426,0-17.067-7.641-17.067-17.067v-102.4c0-9.426-7.641-17.067-17.067-17.067s-17.067,7.641-17.067,17.067v102.4
                 c0,28.277,22.923,51.2,51.2,51.2H409.6c28.277,0,51.2-22.923,51.2-51.2v-102.4C460.8,314.841,453.159,307.2,443.733,307.2z"/></g>
    <g><path d="M335.947,295.134c-6.614-6.387-17.099-6.387-23.712,0L256,351.334V17.067C256,7.641,248.359,0,238.933,0
                 s-17.067,7.641-17.067,17.067v334.268l-56.201-56.201c-6.78-6.548-17.584-6.36-24.132,0.419c-6.388,6.614-6.388,17.099,0,23.713
                 l85.333,85.333c6.657,6.673,17.463,6.687,24.136,0.031c0.01-0.01,0.02-0.02,0.031-0.031l85.333-85.333
                 C342.915,312.486,342.727,301.682,335.947,295.134z"/></g>
    </svg>`;

  var btnId = "download-juejin-book-monkey";

  // --- 基础工具 ---
  const generateId = () => Math.random().toString(36).substring(2, 10);

  function complianceName(name) {
    return name
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/^\.+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // --- API 获取 ---
  const getSectionList = async (bookID = $nuxt.context.params.id) => {
    const response = await fetch(
      "https://api.juejin.cn/booklet_api/v1/booklet/get",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ booklet_id: bookID }),
        method: "POST",
      },
    );
    const { data } = await response.json();
    return data.sections;
  };

  const getMarkdownContent = async (sectionID) => {
    const response = await fetch(
      "https://api.juejin.cn/booklet_api/v1/section/get",
      {
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ section_id: sectionID }),
        method: "POST",
      },
    );
    const { data } = await response.json();
    return data.section;
  };

  // --- 核心逻辑：带并发控制的图片下载 ---
  async function downloadAndSaveImages(
    directoryHandle,
    articleName,
    markdownContent,
  ) {
    let newMarkdown = markdownContent;
    const folderName = `${complianceName(articleName)}_images`;
    const CONCURRENCY_LIMIT = 8; // 并发数限制为 8

    let imagesFolderHandle;
    try {
      imagesFolderHandle = await directoryHandle.getDirectoryHandle(
        folderName,
        { create: true },
      );
    } catch (e) {
      console.warn(`无法创建目录 ${folderName}`, e);
      return markdownContent;
    }

    // 提取所有可能的 URL
    const patterns = [
      /!\[.*?\]\((https?:\/\/.*?)\)/g, // 行内式
      /^\[[\w\s\-\.]+\]:\s*(https?:\/\/.*)$/gm, // 引用式
      /<img\s+[^>]*src=["'](https?:\/\/.*?)["'][^>]*>/g, // HTML
    ];

    const urlSet = new Set();
    patterns.forEach((reg) => {
      const matches = [...markdownContent.matchAll(reg)];
      matches.forEach((m) =>
        urlSet.add(reg.global && reg.multiline ? m[2] : m[2] || m[1]),
      );
    });

    const urls = Array.from(urlSet);
    if (urls.length === 0) return markdownContent;

    const urlMap = new Map(); // 原 URL -> 本地相对路径
    let currentIndex = 0;

    // 下载单个图片的函数
    const downloadWorker = async () => {
      while (currentIndex < urls.length) {
        const url = urls[currentIndex++];
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error("Fetch failed");
          const blob = await response.blob();

          let ext = blob.type.split("/")[1] || "png";
          if (ext.includes("+")) ext = ext.split("+")[0];
          const fileName = `img_${generateId()}.${ext}`;

          const fileHandle = await imagesFolderHandle.getFileHandle(fileName, {
            create: true,
          });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();

          urlMap.set(url, `./${folderName}/${fileName}`);
        } catch (err) {
          console.error(`下载失败: ${url}`, err);
        }
      }
    };

    // 启动并发池
    const pool = Array(Math.min(CONCURRENCY_LIMIT, urls.length))
      .fill(null)
      .map(() => downloadWorker());

    await Promise.all(pool);

    // 最后统一替换 Markdown 中的链接
    urlMap.forEach((localPath, remoteUrl) => {
      // 使用 split/join 替换所有出现的该 URL
      newMarkdown = newMarkdown.split(remoteUrl).join(localPath);
    });

    return newMarkdown;
  }

  // --- 保存流程 ---
  async function saveFile(directoryHandle, index, name, content) {
    try {
      console.log(`[处理中] 第 ${index} 篇: ${name}`);
      const processedContent = await downloadAndSaveImages(
        directoryHandle,
        name,
        content,
      );

      const fileName = `${index}、${complianceName(name)}.md`;
      const fileHandle = await directoryHandle.getFileHandle(fileName, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(processedContent);
      await writable.close();
      console.log(`[完成] ✅ ${fileName}`);
    } catch (error) {
      console.error(`[出错] ❌ ${name}:`, error);
    }
  }

  // --- UI 注入 ---
  function init() {
    if (document.querySelector(`#${btnId}`)) return;
    const titleHeader = document.querySelector(
      ".book-content__header>div.title",
    );
    if (!titleHeader) return;

    const btn = document.createElement("a");
    btn.id = btnId;
    btn.innerHTML = svgDownloadBtn.replace("%color", "#8a919f");
    btn.setAttribute(
      "style",
      "cursor:pointer; padding:0 15px; display:flex; align-items:center;",
    );
    btn.title = "下载";

    btn.onclick = async () => {
      if (!window.showDirectoryPicker)
        return alert("请使用 Chrome/Edge 浏览器");
      try {
        const dirHandle = await window.showDirectoryPicker({
          mode: "readwrite",
        });
        const sections = await getSectionList();

        for (let i = 0; i < sections.length; i++) {
          const data = await getMarkdownContent(sections[i].section_id);
          await saveFile(dirHandle, i + 1, data.title, data.markdown_show);
          // 章节间保持微小延迟，防止接口 API 频率限制
          await new Promise((r) => setTimeout(r, 200));
        }
        alert("导出完成！");
      } catch (err) {
        if (err.name !== "AbortError") alert("导出失败");
      }
    };
    titleHeader.appendChild(btn);
  }

  setInterval(init, 2000);
})();
