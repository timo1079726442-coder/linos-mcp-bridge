import React, { useEffect, useState } from "react";
export function SettingsPage() {
    const [profile, setProfile] = useState(null);
    useEffect(() => { void refresh(); }, []);
    async function refresh() {
        const a = await window.c2c.profile.getActive();
        setProfile(a);
    }
    if (!profile) {
        return (<>
        <div className="page-title">Settings</div>
        <div className="banner warn">未选择 Active Profile。请到 Workspace 页创建或激活一个。</div>
      </>);
    }
    return (<>
      <div className="page-title">Settings</div>

      <div className="card">
        <div className="section-title">ChatGPT 集成</div>
        <div className="kv">
          <div className="k">ChatGPT Launch URL</div>
          <div className="v">{profile.chatgptLaunchUrl}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Auto Start</div>
        <div className="kv">
          <div className="k">Start at Windows Login</div>
          <div className="v">{profile.autoStart.atLogin ? "Yes" : "No"}</div>
          <div className="k">Start Minimized</div>
          <div className="v">{profile.autoStart.minimized ? "Yes" : "No"}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Auto Repair</div>
        <div className="kv">
          <div className="k">Policy</div>
          <div className="v">{profile.autoRepair.policy}</div>
          <div className="k">Max Retries / Day</div>
          <div className="v">{profile.autoRepair.maxRetriesPerDay}</div>
          <div className="k">Cooldown (sec)</div>
          <div className="v">{profile.autoRepair.cooldownSec}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Health Check</div>
        <div className="kv">
          <div className="k">Interval (sec)</div>
          <div className="v">{profile.healthCheckIntervalSec}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Secret Status</div>
        <div className="kv">
          <div className="k">runtimeInstanceSecret</div>
          <div className="v">Configured (in-memory only)</div>
          <div className="k">adminControlKey</div>
          <div className="v">Derived (HKDF)</div>
          <div className="k">Trusted Redirect Policy</div>
          <div className="v">
            builtin: {profile.trustedRedirectPolicy.builtinOrigins.length},
            user-approved: {profile.trustedRedirectPolicy.userApprovedOrigins.length}
          </div>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Secret 不显示明文。CP9 + CP10 完善密钥生命周期。
        </div>
      </div>
    </>);
}
