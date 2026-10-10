import { Drawer } from "antd";
import { ClipExportTasks } from "./ClipExportTasks";
export default function ExportQueueDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      title="片段导出任务"
      open={open}
      size={520}
      onClose={onClose}
      destroyOnHidden
    >
      {open ? <ClipExportTasks /> : null}
    </Drawer>
  );
}
