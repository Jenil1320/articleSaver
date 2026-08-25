package com.folio.reader;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/**
 * A page that builds itself with JavaScript has almost nothing in the HTML the server
 * sends. The desktop version of Folio started a headless Chromium for those. On a phone
 * the browser engine is already here, so a second WebView — laid out but invisible —
 * loads the page, lets its scripts run, and hands back the finished document.
 *
 * This is also what clears the "checking your browser" interstitials, because it is a
 * real browser doing real work rather than an impersonation of one.
 */
final class Renderer {

    /** Markers that mean "this is a bot wall, not the article". */
    private static final String[] CHALLENGE_MARKERS = {
            "just a moment",
            "enable javascript and cookies to continue",
            "checking your browser",
            "cf-browser-verification",
            "_cf_chl_opt",
            "attention required! | cloudflare",
            "px-captcha",
    };

    /**
     * A lazy-loading page only fills in a picture's real address once that picture
     * comes near the viewport. Nothing ever scrolls here, so everything below the
     * fold kept its placeholder and the saved article lost its charts. Running the
     * page past its own scroll positions once lets those loaders do their work.
     */
    private static final String PRIME_JS =
            "(function(){try{var h=document.body?document.body.scrollHeight:0;"
                    + "for(var y=0;y<h;y+=500)window.scrollTo(0,y);"
                    + "window.scrollTo(0,0)}catch(e){}})()";

    private static final long SETTLE_MS = 1400;
    private static final long CHALLENGE_WAIT_MS = 3500;
    private static final int MAX_CHALLENGE_RETRIES = 3;
    private static final long HARD_TIMEOUT_MS = 40000;

    interface Callback {
        void done(boolean ok, String relativePath, String finalUrl, String error);
    }

    private Renderer() {
    }

    static boolean looksChallenged(String html) {
        if (html == null) return false;
        String head = html.substring(0, Math.min(html.length(), 6000)).toLowerCase();
        for (String marker : CHALLENGE_MARKERS) {
            if (head.contains(marker)) return true;
        }
        return false;
    }

    @SuppressLint("SetJavaScriptEnabled")
    static void render(final MainActivity activity, final String url, final Callback callback) {
        final Handler handler = new Handler(Looper.getMainLooper());
        final FrameLayout host = activity.hiddenHost();
        final WebView view = new WebView(activity);
        final boolean[] finished = {false};
        final int[] attempts = {0};
        // deliver() arrives on the WebView's private bridge thread, where calling any
        // WebView method throws. The URL the page landed on after its redirects is
        // captured on the UI thread instead, for deliver() to read from here.
        final AtomicReference<String> landedUrl = new AtomicReference<String>();

        final Runnable[] cleanup = new Runnable[1];
        cleanup[0] = new Runnable() {
            @Override
            public void run() {
                try {
                    host.removeView(view);
                    view.stopLoading();
                    view.destroy();
                } catch (Exception ignored) {
                    // Tearing down twice is harmless.
                }
            }
        };

        final Callback once = new Callback() {
            @Override
            public void done(boolean ok, String path, String finalUrl, String error) {
                if (finished[0]) return;
                finished[0] = true;
                handler.post(cleanup[0]);
                callback.done(ok, path, finalUrl, error);
            }
        };

        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadsImagesAutomatically(false);   // the text is what is wanted here
        s.setBlockNetworkImage(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 "
                + "(KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36");
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        // This is the one WebView that runs a page Folio does not trust, so the file
        // and content access the main view refuses is refused here explicitly too —
        // not left to whatever the platform's defaults happen to be.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        //noinspection deprecation
        s.setAllowFileAccessFromFileURLs(false);
        //noinspection deprecation
        s.setAllowUniversalAccessFromFileURLs(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);

        view.setAlpha(0f);
        view.setBackgroundColor(Color.TRANSPARENT);
        // Laid out at full size so the page believes it has a real viewport, but drawn
        // at zero opacity beneath the library and never touchable.
        view.setEnabled(false);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
        host.addView(view, 0, lp);
        view.setVisibility(View.VISIBLE);

        view.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void deliver(String html) {
                if (html == null || html.length() < 200) {
                    once.done(false, null, url, "That page returned nothing to read.");
                    return;
                }
                if (looksChallenged(html) && attempts[0] < MAX_CHALLENGE_RETRIES) {
                    attempts[0] += 1;
                    handler.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            grab(view);
                        }
                    }, CHALLENGE_WAIT_MS);
                    return;
                }
                try {
                    File out = new File(Storage.sub(activity, "tmp"),
                            UUID.randomUUID().toString().replace("-", "") + ".html");
                    try (FileOutputStream os = new FileOutputStream(out)) {
                        os.write(html.getBytes(StandardCharsets.UTF_8));
                    }
                    String landed = landedUrl.get();
                    once.done(true, "tmp/" + out.getName(), landed == null ? url : landed, null);
                } catch (Exception e) {
                    once.done(false, null, url, "The rendered page could not be stored.");
                }
            }
        }, "FolioRenderSink");

        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String finishedUrl) {
                landedUrl.set(finishedUrl);
                try {
                    v.evaluateJavascript(PRIME_JS, null);
                } catch (Exception ignored) {
                    // Priming is an improvement, never a requirement.
                }
                handler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        grab(v);
                    }
                }, SETTLE_MS);
            }

            @Override
            public void onReceivedError(WebView v, android.webkit.WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                // Only a failure of the main document matters; a blocked tracker does not.
                if (request != null && request.isForMainFrame()) {
                    once.done(false, null, url, "That page could not be opened.");
                }
            }
        });

        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!finished[0]) {
                    // Take whatever has arrived rather than give the reader nothing.
                    grab(view);
                    handler.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            once.done(false, null, url, "That page took too long to build itself.");
                        }
                    }, 1500);
                }
            }
        }, HARD_TIMEOUT_MS);

        try {
            view.loadUrl(url);
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "Render failed to start", e);
            once.done(false, null, url, "That link could not be opened.");
        }
    }

    private static void grab(WebView view) {
        try {
            view.evaluateJavascript(
                    "(function(){try{FolioRenderSink.deliver("
                            + "document.documentElement.outerHTML)}catch(e){}})()", null);
        } catch (Exception ignored) {
            // The hard timeout is the backstop.
        }
    }
}
