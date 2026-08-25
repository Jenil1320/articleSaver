package com.folio.reader;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;

/**
 * Files the app owns, all under {@code filesDir/web} so the WebView can read them
 * back over the asset-loader origin instead of through the JavaScript bridge.
 * A 40 MB PDF crossing the bridge as a string would be copied several times; served
 * as a URL it is streamed once.
 */
final class Storage {

    /** Largest file Folio will take in. */
    static final long MAX_BYTES = 60L * 1024 * 1024;

    private Storage() {
    }

    static File webRoot(Context c) {
        File dir = new File(c.getFilesDir(), "web");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    static File sub(Context c, String name) {
        File dir = new File(webRoot(c), name);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /** The URL the page uses to read a file back. */
    static String urlFor(String relativePath) {
        return MainActivity.ORIGIN + "/files/" + relativePath;
    }

    static File resolve(Context c, String relativePath) {
        File root = webRoot(c);
        File target = new File(root, relativePath);
        // Refuse anything that climbs out of the app's own directory.
        try {
            if (!target.getCanonicalPath().startsWith(root.getCanonicalPath())) return null;
        } catch (Exception e) {
            return null;
        }
        return target;
    }

    /**
     * Copy something handed over by another app into Folio's own storage. The sending
     * app may revoke the permission the moment its activity finishes, so the bytes have
     * to be taken now rather than referenced later.
     */
    static String importShared(Context c, Uri uri, String declaredMime) throws Exception {
        String name = displayName(c, uri);
        String mime = declaredMime;
        if (mime == null || mime.isEmpty() || "application/octet-stream".equals(mime)) {
            String fromResolver = c.getContentResolver().getType(uri);
            if (fromResolver != null) mime = fromResolver;
        }
        String ext = extensionFor(name, mime);

        File dir = sub(c, "shared");
        File out = new File(dir, UUID.randomUUID().toString().replace("-", "") + ext);

        long written;
        try (InputStream in = c.getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IllegalStateException("the file could not be opened");
            written = copy(in, out, MAX_BYTES);
        }

        JSONObject o = new JSONObject();
        o.put("type", "file");
        o.put("path", "shared/" + out.getName());
        o.put("url", urlFor("shared/" + out.getName()));
        o.put("name", name == null || name.isEmpty() ? ("document" + ext) : name);
        o.put("mime", mime == null ? "" : mime);
        o.put("size", written);
        return o.toString();
    }

    static long copy(InputStream in, File out, long limit) throws Exception {
        byte[] buf = new byte[64 * 1024];
        long total = 0;
        try (OutputStream os = new FileOutputStream(out)) {
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > limit) {
                    os.close();
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    throw new IllegalStateException(
                            "that file is larger than " + (limit / (1024 * 1024)) + " MB");
                }
                os.write(buf, 0, n);
            }
        }
        return total;
    }

    static String displayName(Context c, Uri uri) {
        if ("file".equals(uri.getScheme())) return uri.getLastPathSegment();
        try (Cursor cursor = c.getContentResolver()
                .query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int col = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (col >= 0) return cursor.getString(col);
            }
        } catch (Exception ignored) {
            // Some providers refuse the query; the extension check below still works.
        }
        return uri.getLastPathSegment();
    }

    static String extensionFor(String name, String mime) {
        if (name != null) {
            int dot = name.lastIndexOf('.');
            if (dot > 0 && dot < name.length() - 1) {
                String ext = name.substring(dot).toLowerCase();
                if (ext.matches("\\.[a-z0-9]{1,6}")) return ext;
            }
        }
        if (mime != null) {
            String fromMime = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (fromMime != null && !fromMime.isEmpty()) return "." + fromMime;
        }
        return ".bin";
    }

    /**
     * Remove working files left behind by a previous run. A shared copy is only ever
     * read by the save that imported it — a PDF's copy moves to orig/ during that
     * save — so one still sitting here an hour later belongs to a save that failed
     * or was abandoned, and nothing will come back for it.
     */
    static void sweepTemp(Context c) {
        long cutoff = System.currentTimeMillis() - 60L * 60 * 1000;
        for (String name : new String[]{"tmp", "shared"}) {
            File[] files = sub(c, name).listFiles();
            if (files == null) continue;
            for (File f : files) {
                if (f.lastModified() < cutoff) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
        }
    }

    /** Delete every stored file: originals, shared imports, working files, exports. */
    static void wipeAll(Context c) {
        for (String name : new String[]{"orig", "shared", "tmp", "export"}) {
            File[] files = sub(c, name).listFiles();
            if (files == null) continue;
            for (File f : files) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }
}
