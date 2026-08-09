package com.folio.reader;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * What the page cannot do for itself.
 *
 * The important one is {@link #fetchUrl}. A page inside a WebView is bound by the
 * same-origin policy, so it cannot read any site it did not come from. Fetching
 * natively is what lets Folio save a link without a server standing in the middle:
 * the request leaves the phone and the bytes land in the app's own storage.
 */
public class Bridge {

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/128.0.0.0 Mobile Safari/537.36";

    private static final int CONNECT_TIMEOUT = 20000;
    private static final int READ_TIMEOUT = 45000;
    private static final int MAX_REDIRECTS = 8;

    private final MainActivity activity;
    private final WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    Bridge(MainActivity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        Storage.sweepTemp(activity);
    }

    /* ── talking back to the page ────────────────────────────────────── */

    void emit(final String event, final String json) {
        final String call = "window.__folioNative && window.__folioNative.on("
                + JSONObject.quote(event) + "," + JSONObject.quote(json) + ")";
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                WebView w = activity.webView();
                if (w != null) w.evaluateJavascript(call, null);
            }
        });
    }

    private void resolve(String requestId, JSONObject payload) {
        try {
            payload.put("requestId", requestId);
        } catch (Exception ignored) {
            // A JSONObject always accepts a string value; nothing to recover from.
        }
        emit("resolve", payload.toString());
    }

    private void fail(String requestId, String message) {
        fail(requestId, message, 0);
    }

    /** The status travels with the failure so the page can tell "slow down" from "gone". */
    private void fail(String requestId, String message, int status) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", message);
            o.put("status", status);
            resolve(requestId, o);
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "Could not report a failure", e);
        }
    }

    /* ── the network ─────────────────────────────────────────────────── */

    /**
     * Fetch a URL and drop the body in a file the page can read.
     *
     * The body is never handed back as a string. A report can be tens of megabytes,
     * and passing that through the bridge would copy it twice and stall the UI thread.
     */
    @JavascriptInterface
    public void fetchUrl(final String requestId, final String url, final String accept,
                         final String referer) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    String current = url;
                    int hops = 0;
                    String contentType = "";
                    int status = 0;

                    while (true) {
                        URL parsed = new URL(current);
                        String scheme = parsed.getProtocol();
                        if (!"http".equals(scheme) && !"https".equals(scheme)) {
                            fail(requestId, "Only web addresses can be saved.");
                            return;
                        }
                        conn = (HttpURLConnection) parsed.openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(CONNECT_TIMEOUT);
                        conn.setReadTimeout(READ_TIMEOUT);
                        conn.setRequestProperty("User-Agent", UA);
                        conn.setRequestProperty("Accept",
                                accept == null || accept.isEmpty()
                                        ? "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8"
                                        : accept);
                        conn.setRequestProperty("Accept-Language", "en-GB,en;q=0.9");
                        // A picture host often refuses a request that arrives with no
                        // page behind it, to stop other sites hotlinking its images.
                        if (referer != null && !referer.isEmpty()) {
                            conn.setRequestProperty("Referer", referer);
                        }
                        conn.connect();

                        status = conn.getResponseCode();
                        // HttpURLConnection will not follow http to https on its own,
                        // which is exactly the hop most sites make.
                        if (status >= 300 && status < 400) {
                            String location = conn.getHeaderField("Location");
                            conn.disconnect();
                            if (location == null || ++hops > MAX_REDIRECTS) {
                                fail(requestId, "That link redirects in a loop.");
                                return;
                            }
                            current = new URL(new URL(current), location).toString();
                            continue;
                        }
                        contentType = conn.getContentType();
                        break;
                    }

                    if (status >= 400) {
                        String note = status == 403 || status == 401
                                ? "That site refused the request. Open it in Chrome and share it into Folio instead."
                                : status == 404
                                ? "That page is not there any more."
                                : status == 429
                                ? "That site is asking for fewer requests at once."
                                : "The site answered with an error (" + status + ").";
                        conn.disconnect();
                        fail(requestId, note, status);
                        return;
                    }

                    File dir = Storage.sub(activity, "tmp");
                    File out = new File(dir, UUID.randomUUID().toString().replace("-", "") + ".bin");
                    long size;
                    try (InputStream in = conn.getInputStream()) {
                        size = Storage.copy(in, out, Storage.MAX_BYTES);
                    }

                    JSONObject o = new JSONObject();
                    o.put("ok", true);
                    o.put("status", status);
                    o.put("contentType", contentType == null ? "" : contentType);
                    o.put("finalUrl", current);
                    o.put("path", "tmp/" + out.getName());
                    o.put("url", Storage.urlFor("tmp/" + out.getName()));
                    o.put("size", size);
                    resolve(requestId, o);
                } catch (java.net.UnknownHostException e) {
                    fail(requestId, "No connection, or that address does not exist.");
                } catch (java.net.SocketTimeoutException e) {
                    fail(requestId, "That site took too long to answer.");
                } catch (javax.net.ssl.SSLException e) {
                    fail(requestId, "That site's security certificate could not be verified.");
                } catch (Exception e) {
                    fail(requestId, e.getMessage() == null ? "That link could not be fetched."
                            : e.getMessage());
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        });
    }

    /**
     * Load a URL in a real, invisible browser and hand back the document its scripts
     * built. This is the escalation for pages that ship an empty shell, and for the
     * "checking your browser" walls a plain request can never clear.
     */
    @JavascriptInterface
    public void renderUrl(final String requestId, final String url) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Renderer.render(activity, url, new Renderer.Callback() {
                        @Override
                        public void done(boolean ok, String path, String finalUrl, String error) {
                            if (!ok) {
                                fail(requestId, error == null ? "That page could not be read." : error);
                                return;
                            }
                            try {
                                JSONObject o = new JSONObject();
                                o.put("ok", true);
                                o.put("status", 200);
                                o.put("contentType", "text/html; charset=utf-8");
                                o.put("finalUrl", finalUrl);
                                o.put("path", path);
                                o.put("url", Storage.urlFor(path));
                                o.put("rendered", true);
                                resolve(requestId, o);
                            } catch (Exception e) {
                                fail(requestId, "The rendered page could not be handed back.");
                            }
                        }
                    });
                } catch (Exception e) {
                    fail(requestId, "A browser could not be started for that page.");
                }
            }
        });
    }

    /* ── files ───────────────────────────────────────────────────────── */

    /** Keep a fetched or shared file as an item's original, so it can be reopened. */
    @JavascriptInterface
    public String keepOriginal(String relativePath, String itemId, String extension) {
        try {
            File src = Storage.resolve(activity, relativePath);
            if (src == null || !src.exists()) return "";
            String ext = extension == null || extension.isEmpty() ? ".pdf" : extension;
            File dest = new File(Storage.sub(activity, "orig"), safe(itemId) + ext);
            if (dest.exists() && !dest.delete()) return "";
            if (!src.renameTo(dest)) {
                try (InputStream in = new java.io.FileInputStream(src)) {
                    Storage.copy(in, dest, Storage.MAX_BYTES);
                }
                //noinspection ResultOfMethodCallIgnored
                src.delete();
            }
            return "orig/" + dest.getName();
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "Could not keep the original", e);
            return "";
        }
    }

    /** Hand an original to whichever app the reader wants to open it in. */
    @JavascriptInterface
    public void openOriginal(String relativePath, String mime) {
        File f = Storage.resolve(activity, relativePath);
        if (f == null || !f.exists()) return;
        try {
            Uri uri = FileProvider.getUriForFile(
                    activity, activity.getPackageName() + ".files", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, mime == null || mime.isEmpty() ? "application/pdf" : mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "Nothing can open that file", e);
        }
    }

    @JavascriptInterface
    public void deleteFile(String relativePath) {
        File f = Storage.resolve(activity, relativePath);
        if (f != null && f.exists()) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    /** Write a backup and offer it to the share sheet. */
    @JavascriptInterface
    public void exportBackup(final String requestId, final String json, final String filename) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    File dir = Storage.sub(activity, "export");
                    File[] old = dir.listFiles();
                    if (old != null) {
                        for (File f : old) {
                            //noinspection ResultOfMethodCallIgnored
                            f.delete();
                        }
                    }
                    File out = new File(dir, safe(filename));
                    try (FileOutputStream os = new FileOutputStream(out)) {
                        os.write(json.getBytes(StandardCharsets.UTF_8));
                    }
                    Uri uri = FileProvider.getUriForFile(
                            activity, activity.getPackageName() + ".files", out);
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("application/json");
                    send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    Intent chooser = Intent.createChooser(send, "Save your Folio backup");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(chooser);

                    JSONObject o = new JSONObject();
                    o.put("ok", true);
                    o.put("bytes", out.length());
                    resolve(requestId, o);
                } catch (Exception e) {
                    fail(requestId, e.getMessage() == null ? "The backup could not be written."
                            : e.getMessage());
                }
            }
        });
    }

    /* ── device ──────────────────────────────────────────────────────── */

    @JavascriptInterface
    public void setChrome(boolean dark) {
        activity.applyChrome(dark);
    }

    @JavascriptInterface
    public void keepAwake(boolean on) {
        activity.keepAwake(on);
    }

    @JavascriptInterface
    public void vibrate(int milliseconds) {
        try {
            Vibrator v = (Vibrator) activity.getSystemService(android.content.Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            int ms = Math.max(1, Math.min(milliseconds, 300));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                //noinspection deprecation
                v.vibrate(ms);
            }
        } catch (Exception ignored) {
            // Haptics are a nicety; a device that refuses them changes nothing.
        }
    }

    @JavascriptInterface
    public void openExternal(String url) {
        try {
            activity.openExternally(Uri.parse(url));
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "Bad outbound link " + url, e);
        }
    }

    @JavascriptInterface
    public void shareText(String text) {
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            Intent chooser = Intent.createChooser(send, "Share");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(chooser);
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "Sharing failed", e);
        }
    }

    @JavascriptInterface
    public String version() {
        try {
            return activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    private static String safe(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "");
        return cleaned.isEmpty() ? "file" : cleaned;
    }
}
