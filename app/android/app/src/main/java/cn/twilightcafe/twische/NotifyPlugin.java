package cn.twilightcafe.twische;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 网页与前台服务之间的桥。
 *
 * 方法名与 `src/lib/notifyChannel.ts` 里的 `NativeNotifyPlugin` 一一对应 ——
 * 那边改一个名字，这里就得跟着改，没有中间层可以兜住。
 *
 * 插件刻意保持"哑"：它不计算任何内容，只做三件事 ——
 * 检查/申请通知权限、把一段算好的文本转交给服务、撤掉通知。
 *
 * 权限走 Capacitor 的别名机制（而不是自己调 requestPermissions）：
 * 框架会负责 requestCode 分配与回调派发，避免与其它插件抢同一个码。
 */
@CapacitorPlugin(
        name = "TwischeNotify",
        permissions = {
            @Permission(
                    alias = "notifications",
                    strings = { Manifest.permission.POST_NOTIFICATIONS })
        })
public class NotifyPlugin extends Plugin {

    private static final String TAG = "TwischeNotify";
    /** 权限回调方法名，必须与本类里带 @PermissionCallback 的方法同名。 */
    private static final String PERMISSION_CALLBACK = "notificationsCallback";

    @PluginMethod
    public void setNotification(PluginCall call) {
        JSONObject plan = call.getObject("plan");
        if (plan == null) {
            // 兼容两种调用形态：setNotification(plan) 与 setNotification({ plan })
            plan = call.getData();
        }
        if (plan == null) {
            call.reject("缺少通知内容");
            return;
        }

        JSONObject payload = new JSONObject();
        try {
            payload.put("id", plan.optInt("id", NotifyService.NOTIFICATION_ID));
            payload.put("tag", plan.optString("tag", "twische.today"));
            payload.put("title", plan.optString("title", ""));
            payload.put("active", plan.optBoolean("active", true));
            payload.put("count", plan.optInt("count", 0));
            // 正文按行拆开：原生侧用 BigTextStyle 逐行渲染，长文本不会被截成一句
            payload.put("lines", splitLines(plan.optString("body", "")));
        } catch (JSONException err) {
            Log.w(TAG, "构造通知负载失败", err);
            call.reject("通知内容无法序列化");
            return;
        }

        if (!payload.optBoolean("active", true) || payload.optString("title", "").isEmpty()) {
            NotifyService.dismiss(getContext());
            call.resolve();
            return;
        }

        if (!canPostNotifications(getContext())) {
            // 没权限时不要启动前台服务：startForeground 会因为发不出通知而抛异常
            call.reject("没有通知权限");
            return;
        }

        NotifyService.push(getContext(), payload);
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        NotifyService.dismiss(getContext());
        call.resolve();
    }

    /**
     * 同步可读的当前权限。
     *
     * 网页侧希望在"要不要发通知"这个判断里同步拿到结果，所以返回的是普通对象，
     * 而不是 Android 原生的 checkSelfPermission 回调。
     */
    @PluginMethod
    public void getPermission(PluginCall call) {
        resolve(call, notificationPermission());
    }

    /**
     * 申请通知权限。
     *
     * Android 13 以下没有这个运行时权限，直接返回 granted ——
     * 让网页侧少写一套版本判断。
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || canPostNotifications(getContext())) {
            resolve(call, "granted");
            return;
        }
        if (getPermissionState("notifications") == PermissionState.DENIED) {
            // 用户明确拒绝（系统层面记成了"不再询问"）：再弹也没用，如实回报，
            // 由界面引导去系统设置。注意不能自己再加一个"问过一次就不再问"的标志 ——
            // 用户**划掉**权限框时权限状态不变，自造标志会让他再也看不到弹框，
            // 而系统其实还允许再问。
            resolve(call, "denied");
            return;
        }

        requestPermissionForAlias("notifications", call, PERMISSION_CALLBACK);
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        resolve(call, notificationPermission());
    }

    private String notificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted";
        return canPostNotifications(getContext()) ? "granted" : "denied";
    }

    private void resolve(PluginCall call, String permission) {
        JSObject result = new JSObject();
        result.put("permission", permission);
        call.resolve(result);
    }

    static boolean canPostNotifications(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** 正文 → 行数组。空行丢掉，避免通知里出现空档。 */
    static JSONArray splitLines(String body) {
        JSONArray out = new JSONArray();
        if (body == null || body.isEmpty()) return out;
        for (String line : body.split("\n")) {
            String trimmed = line.trim();
            if (!trimmed.isEmpty()) out.put(trimmed);
        }
        return out;
    }
}
