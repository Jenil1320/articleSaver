package com.folio.reader;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import java.util.Calendar;
import java.util.Locale;
import java.util.Random;

/**
 * The daily nudge. One notification a day at roughly the chosen time, worded by
 * someone who wants the reader to read but refuses to be serious about it.
 *
 * The alarm is inexact on purpose: a reading reminder that arrives at 19:34 instead
 * of 19:30 costs nothing, and an inexact alarm needs no special permission and lets
 * the phone sleep. Each firing schedules the next, and a reboot or a clock change
 * re-arms it through the broadcast filter in the manifest.
 */
public class ReminderReceiver extends BroadcastReceiver {

    static final String ACTION_REMIND = "com.folio.reader.REMIND";
    static final String PREFS = "folio-reminder";
    static final String CHANNEL = "nudges";
    private static final int NOTIFICATION_ID = 101;

    /* One-liners with no facts required. {title, body} */
    private static final String[][] PLAIN = {
            {"Psst. Words.", "The good kind — the ones you chose to keep. Five minutes?"},
            {"Your future self called", "They want to be the person who finished that article."},
            {"Folio misses you", "The articles are talking about you behind your back."},
            {"Reading o'clock", "Somewhere it is always reading o'clock. Here, for instance. Now."},
            {"The plot thickens", "Somewhere in your library, unsupervised. Go check on it."},
            {"Tiny reading break?", "Shorter than a doomscroll, and the aftertaste is better."},
            {"Beep boop. Book app.", "Technically articles. Still counts. Five minutes?"},
            {"This is your goofy reminder", "You asked for goofy. Now go read something."},
            {"A wild reading break appeared!", "It's super effective against the endless feed."},
            {"Your bookmarks formed a union", "First demand: be read occasionally. Seems fair."},
    };

    /* Lines that use the unread count. %d is the count. */
    private static final String[][] WITH_UNREAD = {
            {"%d saved reads are gathering dust", "Dust! In a digital library! Come dust one off."},
            {"Breaking: local library ignored", "%d saved reads await. The librarian (you) is concerned."},
            {"Your reading pile can see you", "All %d of them. They know you're on your phone anyway."},
            {"%d articles, zero pressure", "Well. A gentle, friendly, daily amount of pressure."},
    };

    /* Lines that use the streak. %d is the day count. */
    private static final String[][] WITH_STREAK = {
            {"Day %d of your streak", "Five little minutes keeps the flame lit. Don't blink."},
            {"Streak check: %d days", "Scientists agree it would be a shame to stop now."},
    };

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (ACTION_REMIND.equals(action)) {
            show(context);
            schedule(context);
            return;
        }
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            schedule(context);
        }
    }

    private static PendingIntent firing(Context c) {
        Intent i = new Intent(c, ReminderReceiver.class).setAction(ACTION_REMIND);
        return PendingIntent.getBroadcast(c, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Arm the next firing, or disarm everything when the reminder is off. */
    static void schedule(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        PendingIntent pi = firing(c);
        if (!p.getBoolean("enabled", false)) {
            am.cancel(pi);
            return;
        }

        Calendar when = Calendar.getInstance();
        when.set(Calendar.HOUR_OF_DAY, p.getInt("hour", 19));
        when.set(Calendar.MINUTE, p.getInt("minute", 30));
        when.set(Calendar.SECOND, 0);
        when.set(Calendar.MILLISECOND, 0);
        // A time already past (or breathing down our neck) means tomorrow's.
        if (when.getTimeInMillis() <= System.currentTimeMillis() + 60_000L) {
            when.add(Calendar.DAY_OF_YEAR, 1);
        }
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when.getTimeInMillis(), pi);
    }

    private static void show(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int unread = p.getInt("unread", 0);
        int streak = p.getInt("streak", 0);

        Random rng = new Random();
        String[] line;
        // Facts first when there are facts worth joking about, plain silliness otherwise.
        int roll = rng.nextInt(10);
        if (streak >= 2 && roll < 3) {
            line = format(WITH_STREAK[rng.nextInt(WITH_STREAK.length)], streak);
        } else if (unread > 0 && roll < 7) {
            line = format(WITH_UNREAD[rng.nextInt(WITH_UNREAD.length)], unread);
        } else {
            line = PLAIN[rng.nextInt(PLAIN.length)];
        }

        NotificationManager nm =
                (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL, "Reading reminders", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("One goofy nudge a day to go read something you saved.");
            nm.createNotificationChannel(channel);
        }

        Intent open = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(c, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(c, CHANNEL)
                : new Notification.Builder(c);
        b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(line[0])
                .setContentText(line[1])
                .setStyle(new Notification.BigTextStyle().bigText(line[1]))
                .setAutoCancel(true);
        if (tap != null) b.setContentIntent(tap);

        try {
            nm.notify(NOTIFICATION_ID, b.build());
        } catch (SecurityException e) {
            // Notifications were turned off after the reminder was set; nothing to do.
            Log.i(MainActivity.TAG, "Nudge suppressed: no notification permission");
        }
    }

    private static String[] format(String[] line, int n) {
        return new String[]{
                String.format(Locale.getDefault(), line[0], n),
                String.format(Locale.getDefault(), line[1], n),
        };
    }
}
