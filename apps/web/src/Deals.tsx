import { useEffect, useRef, useState } from "react";
import { CreateDeal } from "./CreateDeal.tsx";
import { DealDetail } from "./DealDetail.tsx";
import { DealList } from "./DealList.tsx";

type View = { name: "list" } | { name: "create" } | { name: "detail"; id: string };

export interface DealsProps {
  role: "buyer" | "seller";
  csrfToken: string;
}

/** The Deal pages of a Buyer or a Seller. The state holds the page that shows. */
export function Deals({ role, csrfToken }: DealsProps) {
  const [view, setView] = useState<View>({ name: "list" });
  const container = useRef<HTMLDivElement>(null);
  const shown = useRef(view.name);

  // Move focus to the heading of the new view (WCAG 2.4.3).
  useEffect(() => {
    if (shown.current !== view.name) {
      container.current?.querySelector<HTMLElement>("h2")?.focus();
      shown.current = view.name;
    }
  }, [view.name]);

  const toList = () => {
    setView({ name: "list" });
  };

  return (
    <div ref={container}>
      {view.name === "list" && (
        <DealList
          canCreate={role === "buyer"}
          onOpen={(id) => {
            setView({ name: "detail", id });
          }}
          onCreate={() => {
            setView({ name: "create" });
          }}
        />
      )}
      {view.name === "create" && (
        <CreateDeal
          csrfToken={csrfToken}
          onCancel={toList}
          onCreated={(deal) => {
            setView({ name: "detail", id: deal.id });
          }}
        />
      )}
      {view.name === "detail" && <DealDetail id={view.id} onBack={toList} />}
    </div>
  );
}
