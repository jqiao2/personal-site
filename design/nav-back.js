const LABELS = {
  "Jason's Film Log.dc.html": "Jason's film log",
  "Film Diary.dc.html": "Film diary",
  "Watchlist.dc.html": "Watchlist",
  "Films Watched.dc.html": "All films",
  "Lists.dc.html": "Lists",
  "Stats.dc.html": "Stats",
  "Edit Favorites.dc.html": "Edit favorites",
  "Film.dc.html": "Film",
  "Film v2.dc.html": "Film",
  "Film Unwatched.dc.html": "Film",
  "Film Watched No Review.dc.html": "Film",
  "Diary Entry.dc.html": "Diary entry",
};

export function resolveBack(fallbackHref, fallbackLabel) {
  try {
    const ref = document.referrer;
    if (ref) {
      const file = decodeURIComponent(new URL(ref).pathname.split("/").pop() || "");
      const here = decodeURIComponent(location.pathname.split("/").pop() || "");
      if (file && file !== here && LABELS[file]) {
        return { href: file, label: LABELS[file] };
      }
    }
  } catch (e) {}
  return { href: fallbackHref, label: fallbackLabel };
}

export function loadStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return JSON.parse(raw);
  } catch (e) {}
  return fallback;
}

export function saveStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

export function handleBack(e) {
  e.preventDefault();
  if (document.referrer && history.length > 1) history.back();
  else window.location.href = e.currentTarget.getAttribute("href");
}
