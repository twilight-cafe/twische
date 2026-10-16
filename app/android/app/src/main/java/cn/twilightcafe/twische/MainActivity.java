package cn.twilightcafe.twische;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * 唯一的 Activity：一个装着 Twische 静态页面的 WebView。
 *
 * 界面完全由网页渲染，这里不做任何 UI —— 组件观感与浏览器里打开时一模一样。
 * 需要注册的只有那个通知插件；前台服务由网页通过插件启动。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册，Bridge 会在那里收集插件列表
        registerPlugin(NotifyPlugin.class);
        super.onCreate(savedInstanceState);

        // 冷启动时先把上次的通知挂回去，不必等网页加载完
        NotifyService.restore(this);
    }
}
