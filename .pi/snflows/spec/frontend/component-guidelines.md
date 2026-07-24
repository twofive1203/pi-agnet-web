# Component Guidelines

> Skeleton installed by SnFlow setup. Fill via the 00-bootstrap-spec task. Never overwritten by SnFlow update.

## Required

- All business-logic browser dialogs (`alert`, `confirm`, `prompt`) must use `useAppDialog()` from `components/AppDialogProvider.tsx`.
- Import `import { useAppDialog } from "@/components/AppDialogProvider"` and call `appDialog.alert()`, `appDialog.confirm()`, or `appDialog.prompt()`.
- Dialog title and button labels should use existing i18n keys (`common.alertTitle`, `common.confirmTitle`, `common.promptTitle`, `common.confirm`, `common.cancel`).
- Business message text should use module-specific i18n keys (e.g., `panels.terminal.confirmClose`, `settings.models.deleteAccountConfirm`).
- Danger destructive confirmations must use `tone: "danger"` option.
- Always include `appDialog` and `t` in `useCallback` dependency arrays when used inside.

## Forbidden

- Do not use `window.alert()`, `window.confirm()`, or `window.prompt()` for business-logic dialogs in client components.
- Do not add new client-side dialog implementations that bypass `AppDialogProvider`.
- Do not copy the `ExtensionDialogHost` or `AppDialogProvider` patterns into local per-component dialog state.
- Do not use bare `alert/confirm/prompt` without the `window.` prefix (they are equivalent and equally forbidden).
- Do not add external icon or dialog library dependencies for alert/confirm/prompt replacement.

## Good Example

```tsx
import { useAppDialog } from "@/components/AppDialogProvider";
import { useI18n } from "@/components/I18nProvider";

function MyComponent() {
  const { t } = useI18n();
  const appDialog = useAppDialog();

  const handleDelete = useCallback(async () => {
    const ok = await appDialog.confirm({
      message: t("myModule.deleteConfirm"),
      tone: "danger",
    });
    if (!ok) return;
    // destructive action
  }, [t, appDialog]);

  const handleRename = useCallback(async () => {
    const name = await appDialog.prompt({
      message: t("myModule.renamePrompt"),
      defaultValue: currentName,
    });
    if (name === null) return;
    // rename action
  }, [t, appDialog, currentName]);

  const handleError = useCallback(async (error: unknown) => {
    await appDialog.alert({
      title: t("common.alertTitle"),
      message: error instanceof Error ? error.message : String(error),
    });
  }, [t, appDialog]);
}
```

## Bad Example

```tsx
// BAD: uses native browser dialog
const ok = window.confirm("Are you sure?");
if (!ok) return;

// BAD: uses bare global function (same as window.confirm)
const name = prompt("Enter name:");
if (name === null) return;

// BAD: missing appDialog/t in dependency array
const handleSubmit = useCallback(async () => {
  const ok = await appDialog.confirm({ message: "Go?" });
  if (!ok) return;
}, []);
```
