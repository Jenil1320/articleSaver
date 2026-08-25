package com.folio.reader;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.app.Activity;

import androidx.core.graphics.Insets;
import androidx.core.view.OnApplyWindowInsetsListener;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * The whole application is one WebView. Everything Folio does — fetching a page,
 * reading a PDF, storing the library — happens on this device; there is no server.
 *
 * The pages are served from {@code https://appassets.androidplatform.net} rather than
 * {@code file://}. That gives the page a secure origin, which is what IndexedDB
 * persistence, the clipboard and module scripts all require.
 */
public class MainActivity extends Activity {

    static final String TAG = "Folio";
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String HOME = ORIGIN + "/assets/web/index.html";

    private FrameLayout root;
    private WebView web;
    private Bridge bridge;
    private boolean pageReady = false;

    /** Shares that arrive before the page has booted wait here. */
    private final Deque<String> pendingShares = new ArrayDeque<>();

    private ValueCallback<Uri[]> fileCallback;
    private static final int REQ_FILE = 4001;
    private static final int REQ_PICK = 4003;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        boolean debuggable =
                (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        // The reader sets its own measure; letting Android scale text again on top
        // makes the layout disagree with the word-offset progress model.
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Cookies belong to the offscreen renderer, not to this view: the library
        // itself is served from local assets and never sets one.
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setBackgroundColor(Color.TRANSPARENT);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/files/", new WebViewAssetLoader.InternalStoragePathHandler(
                        this, Storage.webRoot(this)))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if (uri.toString().startsWith(ORIGIN)) return false;
                // An outbound link belongs in the browser, not inside the library.
                openExternally(uri);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushInsets();
                drainShares();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, m.message() + "  (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        bridge = new Bridge(this, web);
        web.addJavascriptInterface(bridge, "FolioNative");

        ViewCompat.setOnApplyWindowInsetsListener(web, new OnApplyWindowInsetsListener() {
            @Override
            public WindowInsetsCompat onApplyWindowInsets(View v, WindowInsetsCompat insets) {
                Insets bars = insets.getInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
                float d = getResources().getDisplayMetrics().density;
                insetTop = bars.top / d;
                insetBottom = Math.max(bars.bottom, ime.bottom) / d;
                insetLeft = bars.left / d;
                insetRight = bars.right / d;
                pushInsets();
                return insets;
            }
        });

        web.loadUrl(HOME);
        handleIntent(getIntent());

        // A force-stop or an OEM battery manager silently cancels the app's alarms.
        // Re-arming on every launch is idempotent: schedule() cancels when the
        // reminder is off and replaces the same PendingIntent when it is on.
        ReminderReceiver.schedule(this);
    }

    /* ── window insets ───────────────────────────────────────────────────
       Android 15 draws every app edge to edge. CSS env(safe-area-inset-*) is not
       filled in for a WebView, so the measured insets are handed to the page as
       custom properties instead. */

    private float insetTop, insetBottom, insetLeft, insetRight;

    private void pushInsets() {
        if (!pageReady) return;
        String css = String.format(
                java.util.Locale.US,
                "document.documentElement.style.setProperty('--inset-top','%.1fpx');"
                        + "document.documentElement.style.setProperty('--inset-bottom','%.1fpx');"
                        + "document.documentElement.style.setProperty('--inset-left','%.1fpx');"
                        + "document.documentElement.style.setProperty('--inset-right','%.1fpx');",
                insetTop, insetBottom, insetLeft, insetRight);
        web.evaluateJavascript(css, null);
    }

    /** Match the system bars to whichever theme the page is showing. */
    void applyChrome(final boolean dark) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                WindowInsetsControllerCompat c =
                        WindowCompat.getInsetsController(getWindow(), web);
                c.setAppearanceLightStatusBars(!dark);
                c.setAppearanceLightNavigationBars(!dark);
                web.setBackgroundColor(dark ? Color.parseColor("#14110F")
                        : Color.parseColor("#FAF9F7"));
            }
        });
    }

    void keepAwake(final boolean on) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }

    /** Android 13 gates notifications behind a runtime permission; ask when enabling. */
    void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return;
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                requestPermissions(
                        new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 4002);
            }
        });
    }

    void openExternally(Uri uri) {
        // A saved page can put any URI in a link — intent:, file:, an app's deep
        // link. Only the schemes a reader legitimately follows may leave the app.
        String scheme = uri == null || uri.getScheme() == null
                ? "" : uri.getScheme().toLowerCase(java.util.Locale.US);
        if (!"http".equals(scheme) && !"https".equals(scheme)
                && !"mailto".equals(scheme) && !"tel".equals(scheme)) {
            Log.w(TAG, "Refusing to open " + uri);
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            Log.w(TAG, "No app can open " + uri, e);
        }
    }

    /* ── incoming shares ─────────────────────────────────────────────── */

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /**
     * Whatever another app has just sent us — but only once.
     *
     * Android keeps the intent that started a task and hands it back whenever a killed
     * process is resumed from the launcher or from recents. Acting on that replay saved
     * the same shared link again every time the app was reopened, and on a first run it
     * spent the welcome screen before anyone had seen it. A replayed intent carries
     * FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY; a real share never does.
     */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String action = intent.getAction();
        if (action == null) return;

        try {
            if (Intent.ACTION_SEND.equals(action)) {
                Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (stream != null) {
                    queueShare(Storage.importShared(this, stream, intent.getType()));
                    return;
                }
                String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                if (text != null && !text.trim().isEmpty()) {
                    JSONObject o = new JSONObject();
                    o.put("type", "text");
                    o.put("text", text);
                    o.put("title", subject == null ? "" : subject);
                    queueShare(o.toString());
                }
            } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
                queueShare(Storage.importShared(this, intent.getData(), intent.getType()));
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not read what was shared", e);
            try {
                JSONObject o = new JSONObject();
                o.put("type", "error");
                o.put("message", "That could not be read: " + e.getMessage());
                queueShare(o.toString());
            } catch (Exception ignored) { /* nothing more to say */ }
        }
    }

    private void queueShare(String json) {
        if (json == null) return;
        pendingShares.add(json);
        if (pageReady) drainShares();
    }

    private void drainShares() {
        while (!pendingShares.isEmpty()) {
            String json = pendingShares.poll();
            bridge.emit("share", json);
        }
    }

    /* ── file picker ─────────────────────────────────────────────────── */

    /**
     * Folio's own picker for the Save → File flow. Unlike the WebView's <input>
     * chooser, the picked document passes through {@link Storage#importShared},
     * which copies the bytes into the app's own storage — so a PDF picked here
     * keeps its original and can be reopened and re-read later.
     */
    void openFilePicker() {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                    "application/pdf", "text/html", "text/markdown", "text/plain"});
            startActivityForResult(i, REQ_PICK);
        } catch (Exception e) {
            Log.w(TAG, "No document picker available", e);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        if (requestCode == REQ_PICK) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                try {
                    queueShare(Storage.importShared(this, data.getData(), data.getType()));
                } catch (Exception e) {
                    Log.w(TAG, "Could not read the picked file", e);
                    try {
                        JSONObject o = new JSONObject();
                        o.put("type", "error");
                        o.put("message", "That file could not be read: " + e.getMessage());
                        queueShare(o.toString());
                    } catch (Exception ignored) { /* nothing more to say */ }
                }
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ── navigation ──────────────────────────────────────────────────── */

    @Override
    public void onBackPressed() {
        // The page decides: a sheet closes, the reader returns to the library, and
        // only the library itself lets the press fall through and leave the app.
        if (!pageReady) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("window.__folioBack && window.__folioBack()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) finish();
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.evaluateJavascript("window.__folioPause && window.__folioPause()", null);
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) {
            bridge.shutdown();
            bridge = null;
        }
        if (web != null) {
            web.removeJavascriptInterface("FolioNative");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    WebView webView() {
        return web;
    }

    /**
     * Where an offscreen renderer parks itself. A WebView that is not laid out never
     * runs a page's scripts, so the hidden one is a full-size sibling drawn at zero
     * opacity underneath the library.
     */
    FrameLayout hiddenHost() {
        return root;
    }
}
