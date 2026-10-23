"use strict";
(() => {
  let key = "";
  let view = "runs";
  let generation = 0;
  const content = document.querySelector("#content");
  const detail = document.querySelector("#detail");
  const message = document.querySelector("#message");
  const statusNames = { success: "完成", partial: "部分完成", blocked: "受阻", "no-change": "无变化",
    AGREED: "多数一致", CONFLICT: "来源冲突", INSUFFICIENT: "来源不足" };
  const scopeNames = { DIRECT: "直销", DISTRIBUTOR: "代销", PARTIAL: "部分渠道", UNSPECIFIED: "未明确" };
  const kindNames = { LIMITED: "限额", PAUSED: "暂停", UNAVAILABLE: "未销售", UNLIMITED: "不限额", UNKNOWN: "未知" };
  const currencyNames = { CNY: "元", USD: "美元", UNSPECIFIED: "（币种待核实）" };
  const text = (tag, value, className) => {
    const element = document.createElement(tag);
    element.textContent = value == null ? "—" : String(value);
    if (className) element.className = className;
    return element;
  };
  const badge = value => text("span", statusNames[value] || value, `badge ${/^[a-zA-Z-]+$/.test(value) ? value : ""}`);
  const date = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
  const table = (headers, rows) => {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const element = document.createElement("table");
    const head = document.createElement("thead");
    const header = document.createElement("tr");
    headers.forEach(value => header.append(text("th", value)));
    head.append(header);
    element.append(head);
    const body = document.createElement("tbody");
    rows.forEach(values => {
      const row = document.createElement("tr");
      values.forEach(value => {
        const cell = document.createElement("td");
        cell.append(value instanceof Node ? value : document.createTextNode(value == null ? "—" : String(value)));
        row.append(cell);
      });
      body.append(row);
    });
    element.append(body);
    wrap.append(element);
    return wrap;
  };
  async function api(path, internal = false) {
    const response = await fetch(path, { headers: internal ? { "X-Internal-Key": key } : {},
      credentials: "omit", cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401) throw new Error("管理密钥不正确，请重新连接。");
      if (response.status === 503) throw new Error("后台尚未配置管理密钥。");
      if (response.status === 404) throw new Error("未找到这份任务报告。");
      throw new Error(`请求失败（${response.status}），请稍后重试。`);
    }
    return response.json();
  }
  function issues(values, target) {
    if (!values.length) return;
    const list = document.createElement("ul");
    list.className = "issues";
    values.forEach(value => list.append(text("li", value)));
    target.append(list);
  }
  async function showRun(id) {
    const selectedGeneration = generation;
    try {
      const run = await api(`/internal/v1/runs/${encodeURIComponent(id)}`, true);
      if (generation !== selectedGeneration || view !== "runs") return;
      detail.replaceChildren(text("h2", "任务详情"));
      detail.append(text("p", `${run.runId} · ${date(run.startedAt)}`, "detail-meta"));
      detail.append(text("p", `发现方式：${run.discoveryMode === "author-profile" ? "作者主页" : "配置笔记"} · 自动发现验证：${run.automaticDiscoveryValidated ? "已验证" : "未验证"}`, "detail-meta"));
      run.results.forEach(source => {
        const section = document.createElement("section");
        section.className = "source-section";
        section.append(text("h3", `来源 ${source.authorId}`), badge(source.status));
        section.append(text("p", `发现 ${source.discoveredCount} 篇 · ${source.transport || "无可用访问方式"}`, "detail-meta"));
        issues(source.issues, section);
        if (source.notes.length) section.append(table(["笔记", "采集状态", "版本"],
          source.notes.map(note => [note.noteId, badge(note.captureStatus), text("span", note.revision || "—", "mono")])));
        source.notes.forEach(note => issues(note.issues, section));
        source.processing.forEach(item => {
          section.append(text("p", `${item.stage} · ${item.status} · ${item.observationCount} 条额度${item.published ? " · 已发布可核对部分" : ""}`, "detail-meta"));
          issues(item.issues, section);
        });
        detail.append(section);
      });
      detail.hidden = false;
    } catch (error) { if (generation === selectedGeneration) message.textContent = error.message; }
  }
  async function refresh() {
    const selectedGeneration = ++generation;
    detail.hidden = true;
    detail.replaceChildren();
    if (view === "runs" && !key) {
      content.replaceChildren(text("div", "连接后查看采集任务", "empty"));
      message.textContent = "输入管理密钥以查看任务报告。";
      return;
    }
    message.textContent = "正在读取…";
    try {
      const result = await api(view === "runs" ? "/internal/v1/runs" : `/api/v1/${view}`, view === "runs");
      if (selectedGeneration !== generation) return;
      if (view === "runs") {
        content.replaceChildren(result.items.length ? table(["开始时间", "状态", "结束时间", "运行编号"], result.items.map(run => {
          const button = text("button", run.runId, "link-button mono");
          button.type = "button";
          button.addEventListener("click", () => showRun(run.runId));
          return [date(run.startedAt), badge(run.status), date(run.finishedAt), button];
        })) : text("div", "尚无任务报告。采集器上传后会出现在这里。", "empty"));
        message.textContent = `最近 ${result.items.length} 次任务 · 点击运行编号查看详情`;
      } else if (view === "quotas") {
        content.replaceChildren(result.items.length ? table(["基金", "口径", "数据日期", "参考值", "校验", "来源"], result.items.map(q => [
          `${q.fundName} · ${q.fundCode}`,
          `${scopeNames[q.channelScope]} / ${q.businessType === "DCA" ? "定投" : q.businessType === "PURCHASE" ? "申购" : "业务未明确"}`,
          q.observedForDate,
          q.limitKind === "LIMITED" ? `${(q.amountMinor / 100).toLocaleString("zh-CN")} ${currencyNames[q.currency] || "（币种待核实）"}` : kindNames[q.limitKind] || "待确认",
          badge(q.status), `${q.supportCount} / ${q.sourceCount}`
        ])) : text("div", "尚无已发布的公开额度。", "empty"));
        message.textContent = `${result.items.length} 条公开参考额度 · 代销范围不等于单个渠道已经确认`;
      } else {
        content.replaceChildren(result.items.length ? table(["作者", "来源编号", "状态"], result.items.map(source => [
          source.name, text("span", source.authorId, "mono"), source.enabled ? "启用" : "停用"
        ])) : text("div", "尚未配置来源。", "empty"));
        message.textContent = `${result.items.length} 个公开来源`;
      }
    } catch (error) {
      if (selectedGeneration !== generation) return;
      message.textContent = error.message;
      content.replaceChildren(text("div", "暂时无法读取数据", "empty"));
    }
  }
  document.querySelector("#connect-form").addEventListener("submit", async event => {
    event.preventDefault();
    const field = document.querySelector("#internal-key");
    key = field.value;
    field.value = "";
    document.querySelector("#disconnect").hidden = false;
    view = "runs";
    document.querySelectorAll("[data-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
    await refresh();
  });
  document.querySelector("#disconnect").addEventListener("click", () => {
    key = "";
    document.querySelector("#internal-key").value = "";
    document.querySelector("#disconnect").hidden = true;
    refresh();
  });
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
    view = button.dataset.view;
    document.querySelectorAll("[data-view]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    refresh();
  }));
  document.querySelector("#refresh").addEventListener("click", refresh);
  window.addEventListener("pagehide", () => { key = ""; });
})();
