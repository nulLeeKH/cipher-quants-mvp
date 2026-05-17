import * as React from "react";
import { render, waitFor, screen } from "@testing-library/react";

const replace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

const useAdminSessionMock = jest.fn();
jest.mock("@/lib/auth/session", () => ({
  useAdminSession: () => useAdminSessionMock(),
}));

import { AdminGuard } from "./AdminGuard";

describe("AdminGuard", () => {
  beforeEach(() => {
    replace.mockReset();
    useAdminSessionMock.mockReset();
  });

  it("shows skeleton placeholder before session has hydrated", () => {
    useAdminSessionMock.mockReturnValue({ session: null, hydrated: false });
    const { container } = render(<AdminGuard>secret</AdminGuard>);
    // Skeleton has aria-hidden, so look for the wrapper div by class.
    expect(container.querySelector(".container")).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });

  it("renders children when session is present", () => {
    useAdminSessionMock.mockReturnValue({
      session: { pubkey: "AdminPubkey" },
      hydrated: true,
    });
    render(<AdminGuard>protected content</AdminGuard>);
    expect(screen.getByText("protected content")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects to /admin/login when hydrated without a session", async () => {
    useAdminSessionMock.mockReturnValue({ session: null, hydrated: true });
    render(<AdminGuard>protected content</AdminGuard>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/admin/login"));
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  });
});
