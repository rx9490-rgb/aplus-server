(function () {
  "use strict";

  var checkoutBusy = false;
  var activeOverlay = null;
  var cardSdkPromise = null;
  var appleSdkPromise = null;

  function apiBase() {
    try {
      var base = typeof window._authAPI === "function"
        ? window._authAPI()
        : (window.APLUS_EXTERNAL_API || window.location.origin + "/api");
      return String(base || "").replace(/\/+$/, "");
    } catch (error) {
      return String(window.APLUS_EXTERNAL_API || window.location.origin + "/api").replace(/\/+$/, "");
    }
  }

  function sessionToken() {
    try {
      return localStorage.getItem("_aplus_session_token")
        || localStorage.getItem("sessionToken")
        || localStorage.getItem("authToken")
        || "";
    } catch (error) {
      return "";
    }
  }

  function notify(message, color) {
    try {
      if (typeof window.showNotification === "function") {
        window.showNotification(message, color || "#f59e0b");
      } else {
        window.alert(message);
      }
    } catch (error) {}
  }

  function getProfile() {
    var profile = window.currentUser && typeof window.currentUser === "object"
      ? window.currentUser
      : {};
    try {
      var stored = localStorage.getItem("currentUser");
      if (stored) {
        try {
          profile = JSON.parse(decodeURIComponent(atob(stored)));
        } catch (decodeError) {
          profile = JSON.parse(stored);
        }
      }
    } catch (error) {}
    return profile || {};
  }

  function nameParts() {
    var profile = getProfile();
    var fullName = String(profile.full_name || profile.fullName || profile.name || profile.email || "A+ User").trim();
    var parts = fullName.split(/\s+/).filter(Boolean);
    return {
      first: String(parts.shift() || "A+").slice(0, 80),
      last: String(parts.join(" ") || "User").slice(0, 80),
      email: String(profile.email || profile.userEmail || "").trim().toLowerCase()
    };
  }

  function loadScript(src, cached) {
    if (cached) return cached;
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing && existing.dataset.loaded === "true") return resolve();
      var script = existing || document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = function () {
        script.dataset.loaded = "true";
        resolve();
      };
      script.onerror = function () {
        reject(new Error("تعذر تحميل واجهة الدفع"));
      };
      if (!existing) document.head.appendChild(script);
    });
  }

  function loadStyle(id, href) {
    if (document.getElementById(id)) return;
    var link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  function buildDialog(title, body) {
    var overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.style.cssText = "position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:1rem;direction:rtl";
    var card = document.createElement("div");
    card.style.cssText = "width:min(430px,100%);max-height:90vh;overflow:auto;padding:1.2rem;border-radius:18px;background:#151327;border:1px solid rgba(212,175,55,.35);box-shadow:0 20px 70px rgba(0,0,0,.55);color:#fff;font-family:inherit";
    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:.8rem;margin-bottom:.8rem">' +
      '<h3 data-title style="margin:0;color:#f0e6c8;font-size:1.05rem"></h3>' +
      '<button type="button" data-close aria-label="إغلاق" style="width:36px;height:36px;border:1px solid rgba(255,255,255,.18);border-radius:50%;background:transparent;color:#fff;font-size:1.2rem;cursor:pointer">×</button>' +
      '</div><div data-body></div>';
    card.querySelector("[data-title]").textContent = title;
    card.querySelector("[data-body]").innerHTML = body;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.querySelector("[data-close]").addEventListener("click", function () {
      closeDialog(overlay);
    });
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) closeDialog(overlay);
    });
    activeOverlay = overlay;
    return overlay;
  }

  function setDialog(overlay, title, body) {
    if (!overlay || !overlay.isConnected) return;
    var titleNode = overlay.querySelector("[data-title]");
    var bodyNode = overlay.querySelector("[data-body]");
    if (titleNode) titleNode.textContent = title;
    if (bodyNode) bodyNode.innerHTML = body;
  }

  function closeDialog(overlay) {
    if (overlay && overlay.isConnected) overlay.remove();
    if (!overlay || activeOverlay === overlay) activeOverlay = null;
    checkoutBusy = false;
  }

  async function loadConfig(token) {
    var response = await fetch(apiBase() + "/payment/tap/inline-config", {
      headers: { "x-session-token": token },
      cache: "no-store"
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "tap_inline_config_failed");
    }
    return data;
  }

  function applePayAvailable() {
    try {
      return !!window.ApplePaySession
        && typeof window.ApplePaySession.canMakePayments === "function"
        && window.ApplePaySession.canMakePayments();
    } catch (error) {
      return false;
    }
  }

  function showMethodPicker(overlay, config, token) {
    var appleOption = applePayAvailable()
      ? '<button type="button" data-method="apple" style="display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;padding:.9rem;margin:.5rem 0;border:1px solid rgba(212,175,55,.35);border-radius:.8rem;background:#0e0d1a;color:#fff;font:inherit;font-weight:800;cursor:pointer"> Apple Pay</button>'
      : '<div style="margin:.5rem 0;padding:.75rem;border-radius:.8rem;background:rgba(255,255,255,.04);color:rgba(255,255,255,.58);text-align:center;font-size:.8rem">Apple Pay غير متاح على هذا الجهاز</div>';
    setDialog(
      overlay,
      "اختر طريقة الدفع",
      '<p style="margin:0 0 .7rem;color:rgba(255,255,255,.65);font-size:.82rem;text-align:center">الدفع يبقى داخل الموقع</p>' +
      appleOption +
      '<button type="button" data-method="card" style="display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;padding:.9rem;margin:.5rem 0;border:1px solid rgba(212,175,55,.35);border-radius:.8rem;background:#0e0d1a;color:#fff;font:inherit;font-weight:800;cursor:pointer">💳 Visa / بطاقة بنكية</button>'
    );
    overlay.querySelectorAll("[data-method]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.getAttribute("data-method") === "apple") {
          showApplePay(overlay, config, token);
        } else {
          showVisa(overlay, config, token);
        }
      });
    });
  }

  function getCardSdk() {
    if (!cardSdkPromise) {
      cardSdkPromise = loadScript("https://tap-sdks.b-cdn.net/card/1.0.2/index.js", cardSdkPromise)
        .then(function () {
          if (!window.CardSDK || typeof window.CardSDK.renderTapCard !== "function") {
            throw new Error("واجهة بطاقة Tap غير متاحة");
          }
          return window.CardSDK;
        });
    }
    return cardSdkPromise;
  }

  function getAppleSdk() {
    if (!appleSdkPromise) {
      loadStyle("tap-apple-pay-sdk-style", "https://tap-sdks.b-cdn.net/apple-pay/build-1.2.0/main.css");
      appleSdkPromise = loadScript("https://tap-sdks.b-cdn.net/apple-pay/build-1.2.0/main.js", appleSdkPromise)
        .then(function () {
          if (!window.TapApplepaySDK || typeof window.TapApplepaySDK.render !== "function") {
            throw new Error("واجهة Apple Pay من Tap غير متاحة");
          }
          return window.TapApplepaySDK;
        });
    }
    return appleSdkPromise;
  }

  async function submitToken(tokenId, overlay, token) {
    var safeTokenId = String(tokenId || "").trim();
    if (!/^tok_[A-Za-z0-9_-]{8,120}$/.test(safeTokenId)) {
      throw new Error("Tap لم يُرجع رمز دفع صالحاً");
    }
    var body = overlay.querySelector("[data-payment-status]");
    if (body) body.textContent = "جارٍ تأكيد الدفع بأمان…";
    var response = await fetch(apiBase() + "/payment/tap/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": token
      },
      body: JSON.stringify({ sourceId: safeTokenId }),
      cache: "no-store"
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || !data.ok || !data.tapId || !data.orderId) {
      throw new Error(data.error || "تعذر بدء الدفع");
    }
    if (data.redirectUrl) {
      window.location.assign(data.redirectUrl);
      return;
    }
    if (String(data.status || "").toUpperCase() !== "CAPTURED") {
      throw new Error("لم يؤكد Tap نجاح الدفع");
    }
    var confirmation = await fetch(apiBase() + "/payment/tap/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": token
      },
      body: JSON.stringify({ orderId: data.orderId, tapId: data.tapId }),
      cache: "no-store"
    });
    var confirmed = await confirmation.json().catch(function () { return {}; });
    if (!confirmation.ok || !confirmed.ok || confirmed.paid !== true) {
      throw new Error(confirmed.error || "payment_not_verified");
    }
    checkoutBusy = false;
    closeDialog(overlay);
    notify("تم تأكيد الدفع وتفعيل الاشتراك", "#10b981");
    window.setTimeout(function () { window.location.reload(); }, 900);
  }

  async function showVisa(overlay, config, token) {
    setDialog(
      overlay,
      "الدفع ببطاقة Visa",
      '<p style="margin:0 0 .65rem;color:rgba(255,255,255,.62);font-size:.78rem">أدخل بيانات البطاقة بأمان داخل هذه الصفحة.</p>' +
      '<div id="tap-card-container" style="direction:ltr;min-height:150px"></div>' +
      '<p data-payment-status role="status" style="min-height:1.2rem;margin:.4rem 0;color:#f0e6c8;font-size:.8rem"></p>' +
      '<button type="button" data-pay disabled style="width:100%;padding:.85rem;border:0;border-radius:.8rem;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;font:inherit;font-weight:800;opacity:.55;cursor:not-allowed">ادفع الآن</button>' +
      '<button type="button" data-back style="width:100%;padding:.7rem;margin-top:.5rem;border:0;background:transparent;color:rgba(255,255,255,.65);font:inherit;cursor:pointer">رجوع لطرق الدفع</button>'
    );
    overlay.querySelector("[data-back]").addEventListener("click", function () {
      showMethodPicker(overlay, config, token);
    });
    var payButton = overlay.querySelector("[data-pay]");
    var statusNode = overlay.querySelector("[data-payment-status]");
    try {
      var sdk = await getCardSdk();
      if (!overlay.isConnected) return;
      var person = nameParts();
      sdk.renderTapCard("tap-card-container", {
        publicKey: config.publicKey,
        merchant: { id: config.merchantId },
        transaction: {
          amount: Number(config.amount),
          currency: config.currency
        },
        customer: {
          name: [{ lang: sdk.Locale && sdk.Locale.EN || "en", first: person.first, last: person.last }],
          contact: person.email ? { email: person.email } : {}
        },
        acceptance: {
          supportedBrands: ["VISA"],
          supportedCards: "ALL"
        },
        fields: { cardHolder: true },
        addons: { displayPaymentBrands: true, loader: true, saveCard: false },
        interface: {
          locale: sdk.Locale && sdk.Locale.EN || "en",
          theme: sdk.Theme && sdk.Theme.DARK || "dark",
          edges: sdk.Edges && sdk.Edges.CURVED || "curved",
          direction: sdk.Direction && sdk.Direction.LTR || "ltr"
        },
        onReady: function () {
          if (statusNode) statusNode.textContent = "";
        },
        onValidInput: function () {
          payButton.disabled = false;
          payButton.style.opacity = "1";
          payButton.style.cursor = "pointer";
        },
        onInvalidInput: function () {
          payButton.disabled = true;
          payButton.style.opacity = ".55";
          payButton.style.cursor = "not-allowed";
        },
        onError: function () {
          if (statusNode) statusNode.textContent = "تعذر قراءة بيانات البطاقة. راجع البيانات وحاول مجدداً.";
        },
        onSuccess: function (result) {
          submitToken(result && result.id, overlay, token).catch(function (error) {
            if (statusNode) statusNode.textContent = "تعذر إتمام الدفع. حاول مرة أخرى.";
            console.error("[Tap embedded payment]", error && error.message || "payment_failed");
            checkoutBusy = false;
          });
        }
      });
      payButton.addEventListener("click", function () {
        if (payButton.disabled || !window.CardSDK || typeof window.CardSDK.tokenize !== "function") return;
        payButton.disabled = true;
        payButton.textContent = "جارٍ التحقق…";
        if (statusNode) statusNode.textContent = "جارٍ التحقق من بيانات البطاقة…";
        window.CardSDK.tokenize();
      });
    } catch (error) {
      if (statusNode) statusNode.textContent = "تعذر تحميل الدفع بالبطاقة. حاول لاحقاً.";
      console.error("[Tap card SDK]", error && error.message || "sdk_load_failed");
      checkoutBusy = false;
    }
  }

  async function showApplePay(overlay, config, token) {
    setDialog(
      overlay,
      "الدفع عبر Apple Pay",
      '<p style="margin:0 0 .65rem;color:rgba(255,255,255,.62);font-size:.78rem;text-align:center">ستظهر نافذة Apple Pay على جهازك.</p>' +
      '<div id="tap-apple-pay-button" style="min-height:48px"></div>' +
      '<p data-payment-status role="status" style="min-height:1.2rem;margin:.5rem 0;color:#f0e6c8;font-size:.8rem;text-align:center"></p>' +
      '<button type="button" data-back style="width:100%;padding:.7rem;margin-top:.5rem;border:0;background:transparent;color:rgba(255,255,255,.65);font:inherit;cursor:pointer">رجوع لطرق الدفع</button>'
    );
    overlay.querySelector("[data-back]").addEventListener("click", function () {
      showMethodPicker(overlay, config, token);
    });
    var statusNode = overlay.querySelector("[data-payment-status]");
    try {
      var sdk = await getAppleSdk();
      if (!overlay.isConnected) return;
      var person = nameParts();
      sdk.render({
        debug: false,
        scope: "TapToken",
        publicKey: config.publicKey,
        environment: "production",
        merchant: {
          domain: window.location.hostname,
          id: config.merchantId
        },
        acceptance: { supportedBrands: ["visa"] },
        features: { supportsCouponCode: false },
        transaction: {
          currency: config.currency,
          amount: String(config.amount)
        },
        customer: {
          name: [{ locale: "en", first: person.first, last: person.last }],
          contact: person.email ? { email: person.email } : {}
        },
        interface: {
          locale: "en",
          theme: "dark",
          type: "buy",
          edges: "curved"
        },
        onCancel: function () {
          if (statusNode) statusNode.textContent = "تم إلغاء Apple Pay.";
          checkoutBusy = false;
        },
        onError: function (error) {
          if (statusNode) statusNode.textContent = "تعذر فتح Apple Pay على هذا الجهاز.";
          console.error("[Tap Apple Pay]", error && error.message || "apple_pay_failed");
          checkoutBusy = false;
        },
        onReady: function () {
          if (statusNode) statusNode.textContent = "";
        },
        onSuccess: function (result) {
          submitToken(result && result.id, overlay, token).catch(function (error) {
            if (statusNode) statusNode.textContent = "تعذر تأكيد الدفع. لا تكرر العملية قبل التحقق.";
            console.error("[Tap Apple Pay payment]", error && error.message || "payment_failed");
            checkoutBusy = false;
          });
        }
      }, "tap-apple-pay-button");
    } catch (error) {
      if (statusNode) statusNode.textContent = "تعذر تحميل Apple Pay. تحقق من إعداد النطاق في Tap.";
      console.error("[Tap Apple Pay SDK]", error && error.message || "sdk_load_failed");
      checkoutBusy = false;
    }
  }

  async function startInlineCheckout() {
    if (checkoutBusy) return;
    var token = sessionToken();
    if (!token) {
      notify("سجّل الدخول أولاً لإتمام الدفع.", "#f59e0b");
      return;
    }
    checkoutBusy = true;
    try {
      var config = await loadConfig(token);
      var overlay = buildDialog("اختر طريقة الدفع", "");
      showMethodPicker(overlay, config, token);
    } catch (error) {
      checkoutBusy = false;
      var message = String(error && error.message || "");
      notify(
        message === "tap_inline_not_configured"
          ? "إعداد الدفع المباشر في Tap غير مكتمل."
          : "تعذر تحميل طرق الدفع. حاول مرة أخرى.",
        "#ef4444"
      );
      console.error("[Tap inline config]", message || "config_failed");
    }
  }

  function updatePaymentButtonLabels() {
    document.querySelectorAll('button[onclick*="openSalaStore"],button[onclick*="openAplusPayment"]').forEach(function (button) {
      button.textContent = " Apple Pay أو 💳 Visa";
    });
  }

  window.openSalaStore = startInlineCheckout;
  window.openAplusPayment = startInlineCheckout;
  window._startTapCheckout = startInlineCheckout;
  updatePaymentButtonLabels();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updatePaymentButtonLabels, { once: true });
  }
})();
