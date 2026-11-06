"""Run in the built backend image: real ASGI routes, no database startup."""
import unittest
from fastapi.testclient import TestClient
from app.cds_runtime import app


class StaticReviewRoutes(unittest.TestCase):
    def test_ordinary_scan_routes_are_present(self):
        paths = {route.path for route in app.routes}
        self.assertIn("/api/v1/scan/upload-zip", paths)
        self.assertIn("/api/v1/tasks/{id}", paths)

    def test_dynamic_and_registration_routes_are_unreachable(self):
        client = TestClient(app)
        for path in ("/api/v1/auth/register", "/api/v1/agent-tasks/",
                     "/api/v1/ssh-keys/", "/docs", "/api/v1/openapi.json"):
            with self.subTest(path=path):
                self.assertEqual(client.post(path, json={}).status_code, 404)

    def test_health_states_verification_mode(self):
        response = TestClient(app).get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.json()["dynamicVerification"], False)


if __name__ == "__main__":
    unittest.main()
