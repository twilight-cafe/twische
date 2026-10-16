package cn.twilightcafe.twische;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 状态栏常驻通知的前台服务。
 *
 * 为什么必须是原生：Android 上「不可划掉、一直在状态栏」的通知只有前台服务能提供。
 * Web 通知哪怕把 ongoing 设上，用户一划就没了，浏览器也不会替你把进程留住。
 *
 * 分工刻意划得很干净：
 * - **内容由网页算**。那里有重复规则展开、向量时钟合并后的完整数据；
 *   在这里重算等于把领域逻辑实现第二遍，两边一旦不一致就会显示过期内容。
 * - **原生只负责显示**。它收下一段已经渲染好的文本，原样挂到状态栏上，
 *   并在开机后把最后一次的内容恢复出来。
 *
 * 因此这里不持有任何日程数据，只存"最后一次要显示的那几行字"。
 */
public class NotifyService extends Service {

    private static final String TAG = "TwischeNotify";

    /** 通知渠道：低优先级，不出提示音、不弹横幅，只安静地待在状态栏。 */
    public static final String CHANNEL_ID = "twische.today";
    public static final String CHANNEL_NAME = "今日待办";

    /** 通知 id 固定，更新同一条而不是叠加。与网页侧 NotifyPlan.key 对应。 */
    public static final int NOTIFICATION_ID = 1;

    public static final String ACTION_UPDATE = "cn.twilightcafe.twische.action.UPDATE";
    public static final String ACTION_CLEAR = "cn.twilightcafe.twische.action.CLEAR";

    /** 网页推过来的负载，字段与 lib/notifyChannel.ts 的 NativeNotifyPlan 一一对应。 */
    public static final String EXTRA_PAYLOAD = "payload";

    /** 最后一次的负载。开机恢复、进程重建都从这里读。 */
    public static final String PREFS = "twische.notify";
    public static final String PREF_PAYLOAD = "payload";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_CLEAR.equals(action)) {
            discard();
            stopSelf();
            return START_NOT_STICKY;
        }

        // 没有新负载时（开机恢复、系统重建服务）读回最后一次的内容
        String payload = intent == null ? null : intent.getStringExtra(EXTRA_PAYLOAD);
        if (payload == null) {
            payload = prefs(this).getString(PREF_PAYLOAD, null);
        }

        if (payload == null || !show(payload)) {
            // 只撤通知，**不删落盘负载**。
            // 这一步很关键：失败原因可能是"后台启动受限""额度用尽"这类**可恢复**的问题，
            // 把负载删掉就把"下次还能补上"变成了"永远补不上"。
            discard();
            stopSelf();
            return START_NOT_STICKY;
        }

        // 被系统杀掉后重建时，先用上次的内容把状态栏补上，等网页重算再刷新
        return START_STICKY;
    }

    /**
     * Android 15 起，前台服务在后台累计运行超时后系统会回调这里；
     * 不在几秒内 stopSelf() 就是一次 RemoteServiceException 崩溃。
     *
     * 本服务的常态就是"一直挂着"，所以这条路必须堵死：降级成普通通知后收工。
     * 用户仍能在状态栏看到内容，只是可能被划掉；等应用回到前台会重新拉起前台服务。
     */
    @Override
    public void onTimeout(int startId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            super.onTimeout(startId);
        }
        Log.w(TAG, "前台服务超时，降级为普通通知");
        stopForeground(STOP_FOREGROUND_DETACH);
        stopSelf();
    }

    /** 显示或更新通知。返回 false 表示这条负载不该显示（缺少必要字段）。 */
    private boolean show(String payload) {
        String title;
        String text;
        try {
            JSONObject json = new JSONObject(payload);
            if (!json.optBoolean("active", true)) return false;
            title = json.optString("title", "");
            text = renderLines(json.optJSONArray("lines"));
            if (title.isEmpty()) return false;
        } catch (Exception err) {
            // 解析不了就当作没有内容：宁可撤掉通知，也不要挂一条自相矛盾的提示
            Log.w(TAG, "通知负载解析失败", err);
            return false;
        }

        NotificationManager manager = getSystemService(NotificationManager.class);
        ensureChannel(manager);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(openApp())
                .setOngoing(true)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build();

        return startForegroundCompat(manager, notification);
    }

    private boolean startForegroundCompat(NotificationManager manager, Notification notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            return true;
        } catch (Exception err) {
            // Android 12+ 在后台启动前台服务会抛 ForegroundServiceStartNotAllowedException，
            // Android 15+ 从 BOOT_COMPLETED 启动非白名单类型也会抛同一个异常。
            // 这时退化成一条普通通知：仍然可见，只是可能被划掉 —— 总好过什么都没有。
            Log.w(TAG, "前台服务启动失败，退化为普通通知", err);
            manager.notify(NOTIFICATION_ID, notification);
            // NotificationManager.notify() 是 oneway 调用，**不会抛异常**：
            // 没权限时系统只是丢掉它。所以要另外查一次真实的开关状态，
            // 不能靠 catch 判断"到底发出去没有"。否则服务会停在一个
            // "既不是前台、也没有通知"的状态里，还对外宣称成功。
            return NotificationManagerCompat.from(this).areNotificationsEnabled();
        }
    }

    /** 把网页算好的行拼成一段文本。 */
    private String renderLines(JSONArray lines) {
        if (lines == null || lines.length() == 0) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < lines.length(); i++) {
            String line = lines.optString(i, "");
            if (line.isEmpty()) continue;
            if (sb.length() > 0) sb.append('\n');
            sb.append("· ").append(line);
        }
        return sb.toString();
    }

    /**
     * 撤掉通知，但**保留**落盘负载。
     *
     * 用于"这一轮没显示成功"或"服务被停掉"的场景：负载还在，
     * 下次开机 / 下次打开应用就能把内容补回来。
     */
    private void discard() {
        getSystemService(NotificationManager.class).cancel(NOTIFICATION_ID);
    }

    private void ensureChannel(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel channel =
                new NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("有逾期事项或今天还有未完成的事项时，把清单挂在状态栏上");
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }

    /** 点通知：把已经开着的窗口拉到前台，而不是再开一个。 */
    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        // singleTask + 这个标志：应用在后台时把它整个拉到前台，不重建 Activity
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        // FLAG_IMMUTABLE 从 API 23 起可用，而 minSdk 是 24，不需要版本判断
        return PendingIntent.getActivity(
                this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 供插件调用：写盘 + 启动服务。启动失败不抛给调用方。 */
    static void push(Context context, JSONObject payload) {
        String json = payload.toString();
        prefs(context).edit().putString(PREF_PAYLOAD, json).apply();

        Intent intent = new Intent(context, NotifyService.class);
        intent.setAction(ACTION_UPDATE);
        intent.putExtra(EXTRA_PAYLOAD, json);
        startCompat(context, intent);
    }

    /** 供插件与开机广播调用：撤掉通知并清掉缓存内容。 */
    static void dismiss(Context context) {
        prefs(context).edit().remove(PREF_PAYLOAD).apply();

        Intent intent = new Intent(context, NotifyService.class);
        intent.setAction(ACTION_CLEAR);
        startCompat(context, intent);
    }

    /** 开机恢复：内容已经在盘上，只需要把服务重新拉起来。 */
    static void restore(Context context) {
        if (cachedPayload(context) == null) return;
        Intent intent = new Intent(context, NotifyService.class);
        intent.setAction(ACTION_UPDATE);
        startCompat(context, intent);
    }

    private static void startCompat(Context context, Intent intent) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception err) {
            // 后台启动受限（Android 12+）时不能让网页侧崩掉：内容已经落盘，
            // 下次应用回到前台时插件会再推一次。
            Log.w(TAG, "启动通知服务失败", err);
        }
    }

    /** 当前缓存的内容，供调试与自检。 */
    static String cachedPayload(Context context) {
        return prefs(context).getString(PREF_PAYLOAD, null);
    }
}
