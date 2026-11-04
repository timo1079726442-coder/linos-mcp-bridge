import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getLegacyRedirectTarget } from "../../navigation/sections.ts";

export function LegacyRouteRedirect(): JSX.Element {
  const { pathname } = useLocation();
  return <Navigate replace to={getLegacyRedirectTarget(pathname) ?? "/"} />;
}
