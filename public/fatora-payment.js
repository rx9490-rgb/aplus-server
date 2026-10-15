(function () {
  "use strict";

  var apiBase = typeof window._authAPI === "function"
    ? window._authAPI()
    : window.location.origin + "/api";
  var tokenKey = "_aplus_session_token";

  function notify(message, color) {
    if (typeof window.showNotification === "function") {
      window.showNotification(message, color || "#10b981");
    } else {
      window.alert(message);
    }
  }

  function cleanPaymentQuery() {
    var url = new URL(window.location.href);
    url.searchParams.delete("payment");
    url.searchParams.delete("order_id");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }

  async function startCheckout(button) {
    var token = window.localStorage.getItem(tokenKey);
    if (!token) {
      notify("سجّل الدخول أولًا قبل إتمام الاشتراك.", "#f59e0b");
      return;
    }

    var originalText = button.textContent;
    button.disabled = true;
    button.textContent = "جارٍ تجهيز صفحة الدفع…";
    try {
      var response = await window.fetch(apiBase + "/payment/fatora/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-token": token
        },
        body: "{}"
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.success || !data.checkoutUrl) {
        throw new Error(data.error || "payment_checkout_failed");
      }
      var checkoutUrl = new URL(data.checkoutUrl);
      if (checkoutUrl.protocol !== "https:") throw new Error("invalid_checkout_url");
      window.location.assign(checkoutUrl.href);
    } catch (error) {
      if (error.message === "fatora_not_configured") {
        notify("الدفع عبر فاتورة لم يُفعّل على الموقع بعد.", "#f59e0b");
      } else {
        notify("تعذّر فتح صفحة الدفع. حاول مرة أخرى أو استخدم سلة.", "#ef4444");
      }
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function makeButton() {
    var button = document.createElement("button");
    button.type = "button";
    button.dataset.fatoraPayment = "true";
    button.textContent = "💳 الدفع عبر فاتورة";
    button.style.cssText = [
      "display:block",
      "width:100%",
      "margin-top:10px",
      "padding:0.85rem",
      "border:1px solid rgba(255,255,255,0.16)",
      "border-radius:0.9rem",
      "background:linear-gradient(135deg,#197b80,#145b60)",
      "color:#fff",
      "font-family:inherit",
      "font-size:0.88rem",
      "font-weight:800",
      "cursor:pointer"
    ].join(";");
    button.addEventListener("click", function () {
      startCheckout(button);
    });
    return button;
  }

  function addButtons() {
    var sallaButtons = document.querySelectorAll(
      '#paymentPage button[onclick*="openSalaStore"], #_subPopupOv button[onclick*="openSalaStore"]'
    );
    sallaButtons.forEach(function (sallaButton) {
      var parent = sallaButton.parentNode;
      if (!parent || parent.querySelector(":scope > [data-fatora-payment='true']")) return;
      parent.insertBefore(makeButton(), sallaButton.nextSibling);
    });
  }

  async function handlePaymentReturn() {
    var params = new URLSearchParams(window.location.search);
    var paymentState = params.get("payment");
    if (paymentState === "fatora_failed") {
      cleanPaymentQuery();
      notify("لم تكتمل عملية الدفع؛ لم يُفعّل الاشتراك.", "#f59e0b");
      return;
    }
    if (paymentState !== "fatora") return;

    var orderId = params.get("order_id");
    var token = window.localStorage.getItem(tokenKey);
    if (!orderId) {
      cleanPaymentQuery();
      notify("تعذّر العثور على رقم عملية الدفع.", "#ef4444");
      return;
    }
    if (!token) {
      notify("سجّل الدخول بالحساب الذي أجرى الدفع ثم أعد تحميل الصفحة.", "#f59e0b");
      return;
    }

    try {
      var response = await window.fetch(apiBase + "/payment/fatora/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-token": token
        },
        body: JSON.stringify({ orderId: orderId })
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.success) throw new Error(data.error || "payment_confirmation_failed");

      cleanPaymentQuery();
      window.sessionStorage.setItem("aplus_fatora_paid_notice", "1");
      window.location.reload();
    } catch (_error) {
      notify("لم نتأكد من الدفع بعد. انتظر لحظات ثم أعد تحميل الصفحة.", "#f59e0b");
    }
  }

  async function initialize() {
    if (window.sessionStorage.getItem("aplus_fatora_paid_notice") === "1") {
      window.sessionStorage.removeItem("aplus_fatora_paid_notice");
      window.setTimeout(function () {
        notify("تم تأكيد الدفع وتفعيل الاشتراك.", "#10b981");
      }, 500);
    }

    await handlePaymentReturn();

    try {
      var response = await window.fetch(apiBase + "/payment/fatora/config", {
        cache: "no-store"
      });
      var config = await response.json();
      if (!response.ok || !config.enabled) return;
      addButtons();
      new MutationObserver(addButtons).observe(document.body, {
        childList: true,
        subtree: true
      });
    } catch (_error) {
      // Keep the existing Salla checkout available if Fatora is unreachable.
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
