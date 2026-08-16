import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { IpamSourcesDialog } from "@/routes/networks";
import { useUi } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { useTranslation } from "react-i18next";

export function IpamSourcesPage() {
  const { t } = useTranslation();
  const environmentId = useUi((state) => state.environmentId);
  return (
    <div className="space-y-5">
      <PageHeader
        back={
          <Button variant="ghost" size="icon" asChild>
            <Link to="/networks" aria-label={t("ipam.backIpam")}>
              <ArrowLeft />
            </Link>
          </Button>
        }
        title={t("ipam.sourceTitle")}
        description={t("ipam.sourcePageDescription")}
      />
      <IpamSourcesDialog environmentId={environmentId} embedded />
    </div>
  );
}
