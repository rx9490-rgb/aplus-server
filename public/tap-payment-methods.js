(function () {
  "use strict";

  var checkoutInProgress = false;

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
      if (typeof window.showNotification === "function") window.showNotification(message, color || "#f59e0b");
      else window.alert(message);
    } catch (error) {}
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

  function buildDialog(title, content) {
    var overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.style.cssText = "position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:1rem;direction:rtl";
    var card = document.createElement("div");
    card.style.cssText = "width:min(390px,100%);padding:1.25rem;border-radius:18px;background:#151327;border:1px solid rgba(212,175,55,.35);box-shadow:0 20px 70px rgba(0,0,0,.55);color:#fff;font-family:inherit";
    var heading = document.createElement("h3");
    heading.textContent = title;
    heading.style.cssText = "margin:0 0 .8rem;color:#f0e6c8;font-size:1.05rem";
    card.appendChild(heading);
    card.insertAdjacentHTML("beforeend", content);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    return overlay;
  }

  function chooseMethod() {
    return new Promise(function (resolve) {
      var content =
        '<button type="button" data-method="src_card" style="display:block;width:100%;padding:.85rem;margin:.5rem 0;border:1px solid rgba(212,175,55,.35);border-radius:.8rem;background:#0e0d1a;color:#fff;font:inherit;font-weight:800;cursor:pointer">💳 Visa أو بطاقة بنكية</button>' +
        (applePayAvailable()
          ? '<button type="button" data-method="src_apple_pay" style="display:block;width:100%;padding:.85rem;margin:.5rem 0;border:1px solid rgba(212,175,55,.35);border-radius:.8rem;background:#0e0d1a;color:#fff;font:inherit;font-weight:800;cursor:pointer"> Apple Pay</button>'
          : "") +
        '<button type="button" data-cancel style="display:block;width:100%;padding:.7rem;margin-top:.7rem;border:0;border-radius:.7rem;background:transparent;color:rgba(255,255,255,.7);font:inherit;cursor:pointer">إلغاء</button>';
      var overlay = buildDialog("اختر طريقة الدفع عبر Tap", content);
      function finish(value) {
        overlay.remove();
        resolve(value);
      }
      overlay.querySelectorAll("[data-method]").forEach(function (button) {
        button.addEventListener("click", function () {
          finish(button.getAttribute("data-method"));
        });
      });
      overlay.querySelector("[data-cancel]").addEventListener("click", function () {
        finish(null);
      });
      overlay.addEventListener("click", function (event) {
        if (event.target === overlay) finish(null);
      });
    });
  }

  function requestPhone() {
    return new Promise(function (resolve) {
      var content =
        '<p style="margin:0 0 .9rem;color:rgba(255,255,255,.68);font-size:.8rem;line-height:1.7">يطلب Tap رقم الجوال لإتمام الدفع.</p>' +
        '<label for="tapPhoneCountry" style="display:block;margin:.45rem 0 .25rem;font-size:.76rem;color:#d4af37">رمز البلد</label>' +
        '<input id="tapPhoneCountry" type="tel" inputmode="numeric" autocomplete="tel-country-code" value="966" maxlength="3" style="width:100%;box-sizing:border-box;padding:.7rem;border-radius:.7rem;border:1px solid rgba(212,175,55,.35);background:#0e0d1a;color:#fff;font:inherit;direction:ltr;text-align:left">' +
        '<label for="tapPhoneNumber" style="display:block;margin:.65rem 0 .25rem;font-size:.76rem;color:#d4af37">رقم الجوال</label>' +
        '<input id="tapPhoneNumber" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="5XXXXXXXX" style="width:100%;box-sizing:border-box;padding:.7rem;border-radius:.7rem;border:1px solid rgba(212,175,55,.35);background:#0e0d1a;color:#fff;font:inherit;direction:ltr;text-align:left">' +
        '<div style="display:flex;gap:.55rem;margin-top:1rem">' +
        '<button type="button" data-continue style="flex:1;padding:.75rem;border:0;border-radius:.7rem;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;font:inherit;font-weight:800;cursor:pointer">متابعة الدفع</button>' +
        '<button type="button" data-cancel style="padding:.75rem 1rem;border:1px solid rgba(255,255,255,.2);border-radius:.7rem;background:transparent;color:#fff;font:inherit;cursor:pointer">إلغاء</button>' +
        "</div>";
      var overlay = buildDialog("رقم الجوال لإتمام الدفع", content);
      var countryInput = overlay.querySelector("#tapPhoneCountry");
      var numberInput = overlay.querySelector("#tapPhoneNumber");
      function finish(value) {
        overlay.remove();
        resolve(value);
      }
      overlay.querySelector("[data-continue]").addEventListener("click", function () {
        var countryCode = String(countryInput.value || "").replace(/\D/g, "").slice(0, 3);
        var number = String(numberInput.value || "").replace(/\D/g, "").replace(/^0+/, "").slice(0, 15);
        if (countryCode.length < 1 || number.length < 5) {
          notify("أدخل رمز بلد ورقم جوال صحيحين.", "#f59e0b");
          return;
        }
        finish({ countryCode: countryCode, number: number });
      });
      overlay.querySelector("[data-cancel]").addEventListener("click", function () {
        finish(null);
      });
      overlay.addEventListener("click", function (event) {
        if (event.target === overlay) finish(null);
      });
      setTimeout(function () { numberInput.focus(); }, 60);
    });
  }

  async function startCheckout(path, body) {
    if (checkoutInProgress) return;
    var token = sessionToken();
    if (!token) {
      notify("سجّل الدخول أولاً لإتمام الدفع عبر Tap.", "#f59e0b");
      return;
    }
    var sourceId = await chooseMethod();
    if (!sourceId) return;
    var phone = await requestPhone();
    if (!phone) return;

    checkoutInProgress = true;
    try {
      var response = await fetch(apiBase() + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-token": token },
        body: JSON.stringify(Object.assign({}, body || {}, { phone: phone, sourceId: sourceId })),
        cache: "no-store",
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.ok || !data.url) {
        throw new Error(data.error || data.msg || "تعذر بدء الدفع عبر Tap.");
      }
      var checkoutUrl = new URL(data.url);
      if (checkoutUrl.protocol !== "https:") throw new Error("رابط دفع Tap غير آمن.");
      window.location.assign(checkoutUrl.href);
    } catch (error) {
      notify("تعذر إنشاء صفحة الدفع عبر Tap. حاول مرة أخرى.", "#ef4444");
      console.error("[Tap checkout]", error && error.message || error);
      checkoutInProgress = false;
    }
  }

  window.openSalaStore = function () {
    return startCheckout("/payment/tap/create");
  };
  window.openAplusPayment = window.openSalaStore;
  window._startTapCheckout = window.openSalaStore;
  window._ptStartTapCheckout = function (tutorId, plan) {
    if (!tutorId || ["lesson", "month"].indexOf(String(plan)) < 0) {
      notify("خيار الدفع غير متاح لهذا المعلم.", "#f59e0b");
      return;
    }
    return startCheckout(
      "/private-tutors/" + encodeURIComponent(String(tutorId)) + "/payment/tap/create",
      { plan: String(plan) }
    );
  };
})();
