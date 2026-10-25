import { App, Button, Tooltip } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { useSettingsModelContext } from "../model/SettingsContext";
import { SaveStatus, SettingControl } from "./SettingsPrimitives";
import PlatformAuthorizationList from "../../../components/PlatformAuthorizationList";
import type { Settings } from "../../../types/settings";
import saveCookieTutorial from "../../../assets/img/save_cookie.png";

export function AuthorizationPanel() {
  const model = useSettingsModelContext();
  const { modal } = App.useApp();
  return (
    <PlatformAuthorizationList
      settings={(model.models.settings as unknown as Settings) ?? null}
      onAuthorized={model.reload}
      onClear={(platform) =>
        modal.confirm({
          title: "清除平台授权？",
          content: "清除后需要重新登录",
          onOk: () => {
            model.change(`${platform}-cookie`, "");
          },
        })
      }
      renderSupplement={(config, hasCookie) => (
        <details className="lr-authorization-manual" data-settings-details>
          <summary>手动粘贴 Cookie（高级）</summary>
          <div className="lr-authorization-manual__content">
            <p>
              进入网页版{config.label}并登录，打开任意直播间后按 F12 →
              网络（Network） → 刷新页面 → 点开任意 {config.manualHost} 请求 →
              在「请求标头」复制完整 Cookie 并粘贴。
              {config.platform === "douyin" && (
                <span className="lr-network-help">
                  <Tooltip
                    placement="top"
                    styles={{
                      root: {
                        width: "min(600px, calc(100vw - 48px))",
                        maxWidth: "none",
                      },
                    }}
                    title={
                      <img
                        className="lr-cookie-tutorial-image"
                        src={saveCookieTutorial}
                        alt="从网络面板保存抖音 Cookie 的教程"
                      />
                    }
                  >
                    <Button
                      aria-label="查看抖音网络面板 Cookie 教程"
                      className="lr-inline-icon-button"
                      size="small"
                      type="text"
                      icon={<QuestionCircleOutlined />}
                    />
                  </Tooltip>
                </span>
              )}
            </p>
            {hasCookie && <p>留空将不会修改</p>}
            <label
              className="lr-settings-sr-only"
              id={`${config.anchor}-label`}
              htmlFor={`${config.anchor}-control`}
            >
              {config.label} Cookie
            </label>
            <div className="lr-authorization-credential-editor">
              <SettingControl
                id={config.anchor}
                manualGroup={`${config.anchor}-manual`}
              />

              <Button
                onClick={() =>
                  model.submit(`${config.anchor}-manual`, [config.anchor])
                }
              >
                保存
              </Button>
            </div>
            <SaveStatus id={`${config.anchor}-manual`} />
          </div>
        </details>
      )}
    />
  );
}
