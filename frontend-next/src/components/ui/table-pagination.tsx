import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

interface TablePaginationProps {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  itemLabel?: string;
}

export function TablePagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  disabled = false,
  itemLabel = "entries",
}: TablePaginationProps) {
  const { t } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const from = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, totalItems);

  if (totalItems <= pageSize) return null;

  return (
    <nav
      aria-label={t("pagination.aria", { item: itemLabel })}
      className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/[0.08] px-4 py-3"
    >
      <span className="text-xs text-muted-foreground">
        {t("pagination.range", { from, to, total: totalItems, item: itemLabel })}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || safePage === 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          {t("pagination.previous")}
        </Button>
        <span className="min-w-20 text-center text-xs text-muted-foreground">
          {t("pagination.page", { page: safePage, total: totalPages })}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || safePage === totalPages}
          onClick={() => onPageChange(safePage + 1)}
        >
          {t("pagination.next")}
        </Button>
      </div>
    </nav>
  );
}
