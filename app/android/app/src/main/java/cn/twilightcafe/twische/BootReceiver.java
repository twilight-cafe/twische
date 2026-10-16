package cn.twilightcafe.twische;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机后把常驻通知补回去。
 *
 * 前台服务不会在重启后自动恢复，而"状态栏上一直挂着还有几件事"这件事
 * 恰恰最需要跨重启成立 —— 用户早上开机看到的第一屏就该是它。
 *
 * 内容取自上次落盘的负载，不需要网页参与；等用户打开应用后再由网页刷新。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        NotifyService.restore(context);
    }
}
