import { Component, Show, createSignal, startTransition } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsProviders } from "./settings-providers"
import { SettingsModels } from "./settings-models"
import { SettingsServers } from "./settings-servers"
import { PromptLibrary } from "@/opencodez/prompt-library"
import { ContextSettings } from "@/opencodez/context-settings"

export const DialogSettings: Component<{ defaultValue?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")
  let leavePrompts: ((action: () => void) => void) | undefined
  let leaveContext: ((action: () => void) => void) | undefined

  const showProviders = () => {
    void dialog.show(() => <DialogSettings defaultValue="providers" />)
  }

  return (
    <Dialog
      size="x-large"
      transition
      classList={{ "oz-prompts-settings": tab() === "prompts", "oz-context-settings": tab() === "context" }}
    >
      <Tabs
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => {
          const change = () => void startTransition(() => setTab(value))
          if (tab() === "prompts" && leavePrompts) return leavePrompts(change)
          if (tab() === "context" && leaveContext) return leaveContext(change)
          change()
        }}
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full gap-4">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="prompts">
                      <Icon name="prompt" />
                      {language.t("opencodez.prompts.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="context">
                      <Icon name="sliders" />
                      {language.t("opencodez.context.title")}
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="servers" class="no-scrollbar">
          <SettingsServers />
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <SettingsProviders onBack={showProviders} />
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <SettingsModels />
        </Tabs.Content>
        <Tabs.Content value="prompts" class="oz-settings-content">
          <Show when={tab() === "prompts"}>
            <PromptLibrary
              onNavigate={(guard) => {
                leavePrompts = guard
              }}
              onSettingsBack={() => leavePrompts?.(() => setTab("general"))}
            />
          </Show>
        </Tabs.Content>
        <Tabs.Content value="context" class="oz-context-content">
          <Show when={tab() === "context"}>
            <ContextSettings
              onNavigate={(guard) => {
                leaveContext = guard
              }}
              onSettingsBack={() => leaveContext?.(() => setTab("general"))}
            />
          </Show>
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
