// Fixture target app behaviour. No dependencies, no build step.

// ---- Elapsed-time stamp -----------------------------------------------
// The number is produced by THIS page's clock (performance.now()), never by the
// capture tooling. That is what makes it usable later as an independent oracle:
// a frame's stamp can be compared against the timestamp the capture adapter claims.
const clock = document.getElementById("clock");
const pad = (n) => String(n).padStart(5, "0");

function tick() {
  const ms = Math.floor(performance.now());
  clock.textContent = "T+" + pad(ms) + " ms";
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---- New client flow --------------------------------------------------
const panel = document.getElementById("form-panel");
const form = document.getElementById("client-form");
const toast = document.getElementById("toast");
const list = document.getElementById("client-list");
const count = document.getElementById("count");

document.getElementById("new-client").addEventListener("click", () => {
  panel.hidden = false;
  toast.hidden = true;
  document.getElementById("name").focus();
});

document.getElementById("cancel").addEventListener("click", () => {
  panel.hidden = true;
  form.reset();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.getElementById("name").value.trim() || "(no name)";
  const email = document.getElementById("email").value.trim() || "(no email)";
  const phone = document.getElementById("phone").value.trim() || "(no phone)";

  const row = document.createElement("li");
  row.className = "row row--new";
  row.setAttribute("data-testid", "client-row");
  for (const [cls, value] of [["row__name", name], ["row__email", email], ["row__phone", phone]]) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = value;
    row.appendChild(span);
  }
  list.prepend(row);
  count.textContent = String(list.children.length);

  form.reset();
  panel.hidden = true;
  toast.textContent = "Client saved successfully: " + name;
  toast.hidden = false;
});
