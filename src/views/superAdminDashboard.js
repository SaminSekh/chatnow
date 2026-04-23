import { Chart, registerables } from "https://esm.sh/chart.js@4.4.2";
import { MESSAGE_TYPES } from "../lib/constants.js";
import { formatDateTime, isLikelyUrl, parseError, showToast, slugify } from "../lib/ui.js";
import {
  createAdminSubscription,
  createSubscriptionPlan,
  deletePaymentMethod,
  fetchMessageOverview,
  getDashboardCounts,
  getSupportMessages,
  listAdminsDetailed,
  listPaymentMethods,
  listPayments,
  listSubscriptionPlans,
  listSupportConversationsForSuper,
  promoteUserToAdminByUsername,
  removeAdmin,
  removeChannel,
  reviewPayment,
  savePaymentMethod,
  sendPasswordResetEmail,
  sendSupportMessage,
  subscribeToSupportMessages,
  updateAdminDetails,
  updatePassword,
  updateProfile,
  uploadAvatar,
  uploadChatMedia,
  uploadVoiceBlob
} from "../services/supabaseApi.js";
import { createVoiceRecorder, renderMessageList, scrollMessagesToBottom } from "./chatUi.js";

Chart.register(...registerables);

export async function renderSuperAdminDashboard({ root, profile, installAvailable, onInstall, onSignOut }) {
  let tab = "overview";
  let counts = {};
  let chartData = [];
  let admins = [];
  let plans = [];
  let paymentMethods = [];
  let payments = [];
  let supportConversations = [];
  let supportConversationId = null;
  let supportMessages = [];
  let supportChannel = null;
  let supportSidebarOpen = false;
  let chart = null;

  async function loadData() {
    // Load essential data first (counts and overview)
    [counts, chartData] = await Promise.all([
      getDashboardCounts(profile.id, "super_admin"),
      fetchMessageOverview(7) // Reduced from 14 to 7 days
    ]);

    // Load other data lazily when tabs are accessed
    admins = [];
    plans = [];
    paymentMethods = [];
    payments = [];
    supportConversations = [];
  }

  async function loadAdminsData() {
    if (admins.length === 0) {
      [admins, plans] = await Promise.all([
        listAdminsDetailed(50), // Load first 50 admins
        listSubscriptionPlans()
      ]);
    }
  }

  let paymentsOffset = 0;
  const PAYMENTS_PAGE_SIZE = 100;

  async function loadPaymentsData() {
    if (payments.length === 0) {
      paymentsOffset = 0;
      [payments, paymentMethods] = await Promise.all([
        listPayments({ limit: PAYMENTS_PAGE_SIZE, offset: 0 }),
        listPaymentMethods(false)
      ]);
    }
  }

  async function loadSupportData() {
    if (supportConversations.length === 0) {
      supportConversations = await listSupportConversationsForSuper(profile.id, 50); // Load first 50 conversations
      if (!supportConversationId && supportConversations.length) {
        supportConversationId = supportConversations[0].id;
        await openSupportConversation(supportConversationId);
      }
    }
  }

  async function reconnectSupportChannel() {
    await removeChannel(supportChannel);
    if (!supportConversationId) return;
    supportChannel = subscribeToSupportMessages(supportConversationId, (message) => {
      supportMessages.push(message);
      const list = root.querySelector("#sa-support-list");
      if (list) {
        renderMessageList(list, supportMessages, profile.id);
        scrollMessagesToBottom(list);
      }
    });
  }

  function renderShell() {
    root.innerHTML = `
      <section class="dashboard">
        <header class="topbar">
          <div>
            <h1>Super Admin Dashboard</h1>
            <p class="muted">${profile.full_name || profile.email}</p>
          </div>
          <div class="inline">
            <button class="btn btn-ghost mobile-menu-btn" id="menu-toggle">Menu</button>
            <span class="badge success">Admins: ${counts.admins || 0}</span>
            <span class="badge warn">Pending Payments: ${counts.pendingPayments || 0}</span>
            <span class="badge">24h Messages: ${counts.last24hMessages || 0}</span>
            <button class="btn btn-secondary ${installAvailable ? "" : "hidden"}" id="install-btn">Install App</button>
            <button class="btn btn-ghost" id="logout-btn">Sign Out</button>
          </div>
        </header>

        <div class="dashboard-body">
          <aside class="sidebar" id="dashboard-sidebar">
            <nav class="tabs">
              <button class="tab-btn active" data-tab="overview">Overview</button>
              <button class="tab-btn" data-tab="admins">Admin Management</button>
              <button class="tab-btn" data-tab="methods">Payment Methods</button>
              <button class="tab-btn" data-tab="payments">Payments</button>
              <button class="tab-btn" data-tab="support">Admin Messages</button>
              <button class="tab-btn" data-tab="profile">Profile</button>
            </nav>
          </aside>
          <section class="panel" id="super-content">
            <div class="loading">Loading dashboard...</div>
          </section>
        </div>
      </section>
    `;

    root.querySelector("#install-btn")?.addEventListener("click", async () => {
      const shown = await onInstall();
      if (shown) showToast("Install prompt opened.");
    });
    root.querySelector("#logout-btn")?.addEventListener("click", onSignOut);
    root.querySelector("#menu-toggle")?.addEventListener("click", () => {
      const sidebar = root.querySelector("#dashboard-sidebar");
      if (!sidebar) return;
      sidebar.classList.toggle("sidebar-open");
    });
    root.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        tab = btn.dataset.tab;
        root.querySelectorAll("[data-tab]").forEach((x) => x.classList.remove("active"));
        btn.classList.add("active");
        await renderTab();
      });
    });
  }

  function destroyChart() {
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }

  function renderOverviewTab() {
    const content = root.querySelector("#super-content");
    content.innerHTML = `
      <div class="stack">
        <h3 style="margin:0;">Daily Message Count by Admin (7 days)</h3>
        <div class="chart-frame">
          <canvas id="overview-chart"></canvas>
        </div>
      </div>
    `;

    const byDay = [...new Set(chartData.map((x) => x.day))].sort();
    const byAdmin = new Map();
    for (const row of chartData) {
      const key = row.admin_name || row.admin_id;
      if (!byAdmin.has(key)) byAdmin.set(key, {});
      byAdmin.get(key)[row.day] = Number(row.message_count);
    }

    const datasets = [...byAdmin.entries()].map(([name, values], index) => ({
      label: name,
      data: byDay.map((day) => values[day] || 0),
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 2,
      borderColor: `hsl(${(index * 57) % 360} 70% 60%)`
    }));

    destroyChart();
    const ctx = content.querySelector("#overview-chart");
    chart = new Chart(ctx, {
      type: "line",
      data: { labels: byDay, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true } }
      }
    });
  }

  function renderAdminsTab() {
    const content = root.querySelector("#super-content");
    content.innerHTML = `
      <div class="stack">
        <form id="add-admin-form" class="stack">
          <h3 style="margin:0;">Promote Existing User to Admin</h3>
          <div class="grid-2">
            <input name="username" placeholder="Existing user username" required />
            <input name="company_name" placeholder="Company name" required />
          </div>
          <div class="grid-2">
            <input name="unique_slug" placeholder="unique-slug" required />
            <input name="remark" placeholder="Remark (optional)" />
          </div>
          <button class="btn btn-primary" type="submit">Promote to Admin</button>
        </form>

        <form id="assign-sub-form" class="stack">
          <h3 style="margin:0;">Assign Subscription</h3>
          <div class="grid-2">
            <select name="admin_id" required>
              <option value="">Select admin</option>
              ${admins.map((a) => `<option value="${a.id}">${a.profile?.full_name || a.profile?.email}</option>`).join("")}
            </select>
            <select name="plan_id" required>
              <option value="">Select plan</option>
              ${plans.map((p) => `<option value="${p.id}">${p.name} (${p.amount})</option>`).join("")}
            </select>
          </div>
          <div class="grid-2">
            <input name="start_date" type="date" required />
            <input name="end_date" type="date" />
          </div>
          <div class="grid-2">
            <input name="grace_days" type="number" min="0" value="0" />
            <select name="status">
              <option value="active">active</option>
              <option value="expired">expired</option>
              <option value="grace">grace</option>
            </select>
          </div>
          <button class="btn btn-secondary" type="submit">Save Subscription</button>
        </form>

        <form id="create-plan-form" class="stack">
          <h3 style="margin:0;">Create Subscription Plan</h3>
          <div class="grid-2">
            <input name="name" placeholder="Plan name" required />
            <input name="amount" type="number" step="0.01" min="0" placeholder="Amount" required />
          </div>
          <input name="duration_days" type="number" min="1" placeholder="Duration days (leave blank for one-time)" />
          <button class="btn btn-secondary" type="submit">Create Plan</button>
        </form>

        <input id="admin-search" placeholder="Search admins..." />
        <div class="table-wrap">
          <table>
            <thead><tr><th>Admin</th><th>Company</th><th>Slug</th><th>Plan</th><th>Actions</th></tr></thead>
            <tbody id="admin-table-body"></tbody>
          </table>
        </div>
      </div>
    `;

    const body = content.querySelector("#admin-table-body");
    const drawRows = () => {
      const term = String(content.querySelector("#admin-search").value || "").toLowerCase().trim();
      const rows = admins.filter((a) => {
        const text = `${a.profile?.full_name || ""} ${a.profile?.email || ""} ${a.company_name || ""} ${a.unique_slug || ""}`.toLowerCase();
        return !term || text.includes(term);
      });
      body.innerHTML = rows.length
        ? rows
            .map(
              (a) => `<tr>
                  <td>${a.profile?.full_name || a.profile?.email}</td>
                  <td>${a.company_name || "-"}</td>
                  <td>${a.unique_slug}</td>
                  <td>${a.latest_subscription?.plan?.name || "-"}</td>
                  <td>
                    <button class="btn btn-ghost" data-edit="${a.id}">Edit</button>
                    <button class="btn btn-ghost" data-reset="${a.profile?.email || ""}">Reset Password</button>
                    <button class="btn btn-danger" data-remove="${a.id}">Delete</button>
                  </td>
                </tr>`
            )
            .join("")
        : `<tr><td colspan="5" class="muted">No admins found.</td></tr>`;

      body.querySelectorAll("[data-edit]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const admin = admins.find((x) => x.id === btn.dataset.edit);
          if (!admin) return;
          const fullName = prompt("Full name", admin.profile?.full_name || "");
          const companyName = prompt("Company name", admin.company_name || "");
          const uniqueSlug = slugify(prompt("Unique slug", admin.unique_slug || ""));
          const remark = prompt("Remark", admin.remark || "");
          if (!fullName || !companyName || !uniqueSlug) return;
          await updateAdminDetails(admin.id, { fullName, companyName, uniqueSlug, remark });
          showToast("Admin updated.");
          admins = await listAdminsDetailed();
          drawRows();
        });
      });

      body.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this admin and demote to user?")) return;
          await removeAdmin(btn.dataset.remove);
          showToast("Admin removed.");
          admins = await listAdminsDetailed();
          drawRows();
        });
      });

      body.querySelectorAll("[data-reset]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!btn.dataset.reset) return;
          await sendPasswordResetEmail(btn.dataset.reset, window.location.origin);
          showToast(`Reset email sent to ${btn.dataset.reset}`);
        });
      });
    };

    content.querySelector("#admin-search").addEventListener("input", drawRows);
    drawRows();

    content.querySelector("#add-admin-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      await promoteUserToAdminByUsername({
        username: String(fd.get("username") || "").trim(),
        companyName: String(fd.get("company_name") || "").trim(),
        uniqueSlug: slugify(String(fd.get("unique_slug") || "")),
        remark: String(fd.get("remark") || "").trim(),
        createdBy: profile.id
      });
      showToast("User promoted to admin.");
      admins = await listAdminsDetailed();
      event.currentTarget.reset();
      drawRows();
    });

    content.querySelector("#assign-sub-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      await createAdminSubscription({
        admin_id: String(fd.get("admin_id") || ""),
        plan_id: String(fd.get("plan_id") || ""),
        start_date: String(fd.get("start_date") || ""),
        end_date: String(fd.get("end_date") || "") || null,
        grace_days: Number(fd.get("grace_days") || 0),
        status: String(fd.get("status") || "active")
      });
      showToast("Subscription assigned.");
      admins = await listAdminsDetailed();
      event.currentTarget.reset();
      drawRows();
    });

    content.querySelector("#create-plan-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      await createSubscriptionPlan({
        name: String(fd.get("name") || "").trim(),
        amount: Number(fd.get("amount") || 0),
        duration_days: fd.get("duration_days") ? Number(fd.get("duration_days")) : null
      });
      showToast("Plan created.");
      plans = await listSubscriptionPlans();
      renderAdminsTab();
    });
  }

  function renderMethodsTab() {
    const content = root.querySelector("#super-content");
    content.innerHTML = `
      <div class="stack">
        <form id="method-form" class="stack">
          <h3 style="margin:0;">Add Payment Method</h3>
          <input name="name" placeholder="Method name" required />
          <textarea name="account_details" placeholder="Account details"></textarea>
          <textarea name="instructions" placeholder="Instructions"></textarea>
          <label><input type="checkbox" name="is_active" checked /> Active</label>
          <button class="btn btn-primary" type="submit">Save Method</button>
        </form>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              ${
                paymentMethods.length
                  ? paymentMethods
                      .map(
                        (m) => `<tr>
                            <td>${m.name}</td>
                            <td>${m.account_details || "-"}</td>
                            <td>${m.is_active ? "active" : "inactive"}</td>
                            <td>
                              <button class="btn btn-ghost" data-edit="${m.id}">Edit</button>
                              <button class="btn btn-danger" data-delete="${m.id}">Delete</button>
                            </td>
                          </tr>`
                      )
                      .join("")
                  : `<tr><td colspan="4" class="muted">No payment methods.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    `;

    content.querySelector("#method-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      await savePaymentMethod({
        name: String(fd.get("name") || "").trim(),
        account_details: String(fd.get("account_details") || "").trim() || null,
        instructions: String(fd.get("instructions") || "").trim() || null,
        is_active: fd.get("is_active") === "on"
      });
      paymentMethods = await listPaymentMethods(false);
      showToast("Payment method saved.");
      renderMethodsTab();
    });

    content.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete payment method?")) return;
        await deletePaymentMethod(btn.dataset.delete);
        paymentMethods = await listPaymentMethods(false);
        showToast("Payment method deleted.");
        renderMethodsTab();
      });
    });

    content.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const method = paymentMethods.find((x) => x.id === btn.dataset.edit);
        if (!method) return;
        const name = prompt("Method name", method.name);
        const details = prompt("Account details", method.account_details || "");
        const instructions = prompt("Instructions", method.instructions || "");
        const active = confirm("Set as active? Click OK for active, Cancel for inactive.");
        if (!name) return;
        await savePaymentMethod(
          {
            name,
            account_details: details || null,
            instructions: instructions || null,
            is_active: active
          },
          method.id
        );
        paymentMethods = await listPaymentMethods(false);
        showToast("Payment method updated.");
        renderMethodsTab();
      });
    });
  }

  function renderPaymentsTab() {
    const content = root.querySelector("#super-content");
    content.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Admin</th><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Proof</th><th>Actions</th></tr></thead>
          <tbody>
            ${
              payments.length
                ? payments
                    .map(
                      (p) => `<tr>
                          <td>${p.admin?.profile?.full_name || p.admin?.profile?.email || p.admin_id}</td>
                          <td>${formatDateTime(p.submitted_at)}</td>
                          <td>${p.amount}</td>
                          <td>${p.method?.name || "-"}</td>
                          <td>${p.status}</td>
                          <td>${p.screenshot_url ? `<a href="${p.screenshot_url}" target="_blank" rel="noopener noreferrer">View</a>` : "-"}</td>
                          <td>
                            <button class="btn btn-secondary" data-approve="${p.id}">Approve</button>
                            <button class="btn btn-danger" data-reject="${p.id}">Reject</button>
                          </td>
                        </tr>`
                    )
                    .join("")
                : `<tr><td colspan="7" class="muted">No payment entries.</td></tr>`
            }
          </tbody>
        </table>
      </div>
      ${payments.length === paymentsOffset + PAYMENTS_PAGE_SIZE
        ? `<button class="btn btn-ghost" id="payments-load-more">Load more</button>`
        : ""}
    `;

    content.querySelector("#payments-load-more")?.addEventListener("click", async () => {
      paymentsOffset += PAYMENTS_PAGE_SIZE;
      const more = await listPayments({ limit: PAYMENTS_PAGE_SIZE, offset: paymentsOffset });
      payments = [...payments, ...more];
      renderPaymentsTab();
    });

    const bindAction = (selector, status) => {
      content.querySelectorAll(selector).forEach((btn) => {
        btn.addEventListener("click", async () => {
          await reviewPayment(btn.dataset.approve || btn.dataset.reject, status, profile.id);
          // Reload current page range to keep pagination state consistent
          payments = await listPayments({ limit: paymentsOffset + PAYMENTS_PAGE_SIZE, offset: 0 });
          showToast(`Payment ${status}.`);
          renderPaymentsTab();
        });
      });
    };
    bindAction("[data-approve]", "approved");
    bindAction("[data-reject]", "rejected");
  }

  function renderSupportTab() {
    const content = root.querySelector("#super-content");
    const selectedSupportConversation = supportConversations.find((c) => c.id === supportConversationId);
    content.innerHTML = `
      <div class="chat-layout ${supportSidebarOpen ? "chat-layout-sidebar-open" : ""}">
        <button class="chat-backdrop" type="button" id="sa-support-sidebar-backdrop" aria-label="Close conversations"></button>
        <aside class="chat-sidebar" id="support-conv-list"></aside>
        <section class="chat-main">
          <header class="chat-header">
            <div class="chat-header-title">
              <button class="chat-menu-btn" type="button" id="sa-support-sidebar-toggle" aria-label="Open conversations">
                <span></span>
              </button>
              <div class="chat-header-copy">
                <strong>Support Thread</strong>
                <span class="muted">
                  ${
                    selectedSupportConversation?.admin?.company_name ||
                    selectedSupportConversation?.admin?.profile?.full_name ||
                    "Choose a conversation"
                  }
                </span>
              </div>
            </div>
          </header>
          <div class="message-list" id="sa-support-list"></div>
          <form class="composer" id="sa-support-form">
            <div class="composer-row">
              <input id="sa-support-input" type="text" placeholder="Reply..." />
              <button class="btn btn-primary" type="submit">Send</button>
            </div>
            <div class="composer-row">
              <input id="sa-support-image" type="file" accept="image/*" />
              <button class="btn btn-secondary" type="button" id="sa-support-send-image">Image</button>
              <button class="btn btn-secondary" type="button" id="sa-support-voice">Voice</button>
            </div>
          </form>
        </section>
      </div>
    `;

    const listPanel = content.querySelector("#support-conv-list");
    listPanel.innerHTML = supportConversations.length
      ? supportConversations
          .map(
            (c) => `<article class="conversation-item ${c.id === supportConversationId ? "active" : ""}" data-id="${c.id}">
                <div class="conversation-name">${c.admin?.company_name || c.admin?.profile?.full_name || c.admin_id}</div>
                <div class="conversation-preview">${formatDateTime(c.updated_at)}</div>
              </article>`
          )
          .join("")
      : `<p class="muted" style="padding:12px;">No support messages yet.</p>`;

    content.querySelector("#sa-support-sidebar-toggle")?.addEventListener("click", () => {
      supportSidebarOpen = !supportSidebarOpen;
      renderSupportTab();
    });

    content.querySelector("#sa-support-sidebar-backdrop")?.addEventListener("click", () => {
      supportSidebarOpen = false;
      renderSupportTab();
    });

    listPanel.querySelectorAll("[data-id]").forEach((row) => {
      row.addEventListener("click", async () => {
        supportSidebarOpen = false;
        await openSupportConversation(row.dataset.id);
        renderSupportTab();
      });
    });

    const msgList = content.querySelector("#sa-support-list");
    renderMessageList(msgList, supportMessages, profile.id);
    scrollMessagesToBottom(msgList, { force: true });

    content.querySelector("#sa-support-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!supportConversationId) {
        showToast("No support conversation selected.", "error");
        return;
      }
      const input = content.querySelector("#sa-support-input");
      try {
        await sendSupportMessage({
          conversationId: supportConversationId,
          senderId: profile.id,
          content: String(input.value || "").trim(),
          messageType: isLikelyUrl(input.value || "") ? MESSAGE_TYPES.LINK : MESSAGE_TYPES.TEXT,
          mediaUrl: null
        });
        input.value = "";
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });

    content.querySelector("#sa-support-send-image")?.addEventListener("click", async () => {
      if (!supportConversationId) {
        showToast("No support conversation selected.", "error");
        return;
      }
      const file = content.querySelector("#sa-support-image")?.files?.[0];
      if (!file) return showToast("Select image first.", "error");
      try {
        const url = await uploadChatMedia(file, profile.id, "support-images");
        await sendSupportMessage({
          conversationId: supportConversationId,
          senderId: profile.id,
          content: "",
          messageType: MESSAGE_TYPES.IMAGE,
          mediaUrl: url
        });
        content.querySelector("#sa-support-image").value = "";
      } catch (error) {
        showToast(parseError(error), "error");
      }
    });

    const recorder = createVoiceRecorder({
      onReady: () => (content.querySelector("#sa-support-voice").textContent = "Stop"),
      onStop: async (blob) => {
        if (!supportConversationId) {
          showToast("No support conversation selected.", "error");
          return;
        }
        try {
          const url = await uploadVoiceBlob(blob, profile.id, "support-voices");
          await sendSupportMessage({
            conversationId: supportConversationId,
            senderId: profile.id,
            content: "",
            messageType: MESSAGE_TYPES.VOICE,
            mediaUrl: url
          });
        } catch (error) {
          showToast(parseError(error), "error");
        } finally {
          content.querySelector("#sa-support-voice").textContent = "Voice";
        }
      },
      onError: (error) => showToast(parseError(error), "error")
    });
    content.querySelector("#sa-support-voice")?.addEventListener("click", async () => {
      const btn = content.querySelector("#sa-support-voice");
      if (btn.textContent === "Stop") recorder.stop();
      else await recorder.start();
    });
  }

  function renderProfileTab() {
    const content = root.querySelector("#super-content");
    content.innerHTML = `
      <div class="stack">
        <form id="sa-profile-form" class="stack">
          <h3 style="margin:0;">Update Profile</h3>
          <input name="full_name" value="${profile.full_name || ""}" placeholder="Full name" />
          <input name="avatar" type="file" accept="image/*" />
          <button class="btn btn-primary" type="submit">Save Profile</button>
        </form>
        <form id="sa-password-form" class="stack">
          <h3 style="margin:0;">Update Password</h3>
          <input name="password" type="password" minlength="6" required placeholder="New password" />
          <button class="btn btn-secondary" type="submit">Update Password</button>
        </form>
      </div>
    `;

    content.querySelector("#sa-profile-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      const payload = { full_name: String(fd.get("full_name") || "").trim() };
      const avatar = fd.get("avatar");
      if (avatar && avatar.size > 0) payload.avatar_url = await uploadAvatar(avatar, profile.id);
      const updated = await updateProfile(payload);
      profile.full_name = updated.full_name;
      showToast("Profile updated.");
    });

    content.querySelector("#sa-password-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const fd = new FormData(event.currentTarget);
      await updatePassword(String(fd.get("password") || ""));
      showToast("Password updated.");
      event.currentTarget.reset();
    });
  }

  async function renderTab() {
    destroyChart();
    const content = root.querySelector("#super-content");
    content.innerHTML = `<div class="loading">Loading...</div>`;

    try {
      if (tab === "overview") return renderOverviewTab();
      if (tab === "admins") {
        await loadAdminsData();
        return renderAdminsTab();
      }
      if (tab === "methods") {
        await loadPaymentsData(); // Payment methods are loaded with payments
        return renderMethodsTab();
      }
      if (tab === "payments") {
        await loadPaymentsData();
        return renderPaymentsTab();
      }
      if (tab === "support") {
        await loadSupportData();
        return renderSupportTab();
      }
      return renderProfileTab();
    } catch (error) {
      root.querySelector("#super-content").innerHTML = `<p class="muted">Failed to render tab: ${parseError(error)}</p>`;
    }
  }

  await loadData();
  renderShell();
  await renderTab();

  return async () => {
    destroyChart();
    await removeChannel(supportChannel);
  };
}
