// Saltmarsh showcase fixture. No dependencies, no network calls.
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Scroll reveal. IntersectionObserver, never a scroll listener. */
  var risers = document.querySelectorAll(".rise");
  if (risers.length) {
    if (reduced || !("IntersectionObserver" in window)) {
      risers.forEach(function (el) { el.classList.add("in"); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry, i) {
          // A jump in scroll position (a capture tool seeking, an anchor click)
          // leaves passed-over elements non-intersecting and above the fold.
          // Reveal those at once instead of stranding them at opacity 0.
          var passed = !entry.isIntersecting && entry.boundingClientRect.top < 0;
          if (!entry.isIntersecting && !passed) return;
          var el = entry.target;
          window.setTimeout(function () { el.classList.add("in"); }, passed ? 0 : i * 70);
          io.unobserve(el);
        });
      }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
      risers.forEach(function (el) { io.observe(el); });
    }
  }

  var form = document.getElementById("signup-form");
  if (!form) return;

  var nameInput = document.getElementById("name");
  var emailInput = document.getElementById("email");
  var passwordInput = document.getElementById("password");
  var terms = document.getElementById("terms");
  var reveal = document.getElementById("reveal");
  var meter = document.getElementById("meter");
  var strengthLabel = document.getElementById("strength-label");
  var strengthTip = document.getElementById("strength-tip");
  var submit = document.getElementById("submit");

  /* ---- password strength, recomputed on every keystroke ---- */

  var LABELS = [
    "Use 10 characters or more",
    "Too easy to guess",
    "Getting there",
    "Good password",
    "Strong password"
  ];

  function score(value) {
    if (!value) return 0;
    if (value.length < 6) return 1;
    var points = 0;
    if (value.length >= 10) points++;
    if (value.length >= 14) points++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) points++;
    if (/[0-9]/.test(value)) points++;
    if (/[^A-Za-z0-9]/.test(value)) points++;
    if (points <= 1) return 1;
    if (points === 2) return 2;
    if (points === 3) return 3;
    return 4;
  }

  function nextTip(value, s) {
    if (!value || s >= 4) return "";
    if (value.length < 10) return (10 - value.length) + " to go";
    if (!/[0-9]/.test(value)) return "add a number";
    if (!/[^A-Za-z0-9]/.test(value)) return "add a symbol";
    if (!/[A-Z]/.test(value)) return "add a capital";
    return "";
  }

  function paintStrength() {
    var value = passwordInput.value;
    var s = score(value);
    meter.setAttribute("data-score", String(s));
    strengthLabel.textContent = LABELS[s];
    strengthTip.textContent = nextTip(value, s);
  }

  passwordInput.addEventListener("input", paintStrength);
  paintStrength();

  reveal.addEventListener("click", function () {
    var hidden = passwordInput.type === "password";
    passwordInput.type = hidden ? "text" : "password";
    reveal.textContent = hidden ? "Hide" : "Show";
  });

  /* ---- validation ---- */

  function setError(fieldId, errorId, message) {
    document.getElementById(fieldId).classList.toggle("invalid", Boolean(message));
    document.getElementById(errorId).textContent = message || "";
    return !message;
  }

  function validate() {
    var okName = setError(
      "field-name", "name-error",
      nameInput.value.trim().length >= 2 ? "" : "Tell us what to call you."
    );
    var okEmail = setError(
      "field-email", "email-error",
      /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailInput.value.trim()) ? "" : "That email does not look right."
    );
    var okPassword = setError(
      "field-password", "password-error",
      score(passwordInput.value) >= 2 ? "" : "Pick something longer than 10 characters."
    );
    var okTerms = setError(
      "field-terms", "terms-error",
      terms.checked ? "" : "Please accept the terms to continue."
    );
    return okName && okEmail && okPassword && okTerms;
  }

  [nameInput, emailInput, passwordInput].forEach(function (input) {
    input.addEventListener("input", function () {
      var field = input.closest(".field");
      if (field && field.classList.contains("invalid")) validate();
    });
  });
  terms.addEventListener("change", function () {
    if (document.getElementById("field-terms").classList.contains("invalid")) validate();
  });

  /* ---- submit -> success ---- */

  function slugify(value) {
    return value.trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "new-studio";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!validate()) return;

    submit.disabled = true;
    submit.textContent = "Creating workspace";

    window.setTimeout(function () {
      var full = nameInput.value.trim();
      document.getElementById("success-name").textContent = full.split(/\s+/)[0];
      document.getElementById("success-slug").textContent = slugify(full);
      document.getElementById("form-view").hidden = true;
      var success = document.getElementById("success-view");
      success.hidden = false;
      if (!reduced) success.classList.add("enter");
      success.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    }, reduced ? 0 : 650);
  });
})();
