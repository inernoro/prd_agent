"""Run in the built backend image: real ASGI routes, no database startup."""
import unittest
from types import SimpleNamespace
from fastapi.testclient import TestClient
from jose import jwt
from app.cds_runtime import app, CDS_ADMIN_EMAIL
from app.core import security
from app.core.config import settings
from app.db.session import get_db


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


class LoginDatabase:
    """Unit-test database boundary; password hashing and JWT signing stay real."""
    def __init__(self, users):
        self.users, self.lookups = users, []

    async def execute(self, statement):
        email = statement.compile().params.get("email_1")
        self.lookups.append(email)
        return SimpleNamespace(scalars=lambda: SimpleNamespace(first=lambda: self.users.get(email)))


class AdministratorAliasAuthentication(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.human_password = "human-admin-unit-test-password"
        cls.service_password = "machine-service-unit-test-password"
        cls.users = {
            CDS_ADMIN_EMAIL: SimpleNamespace(id="human-admin", is_active=True,
                hashed_password=security.get_password_hash(cls.human_password)),
            "cds-review@example.com": SimpleNamespace(id="machine-service", is_active=True,
                hashed_password=security.get_password_hash(cls.service_password)),
        }

    def setUp(self):
        self.db = LoginDatabase(self.users)
        async def database():
            yield self.db
        app.dependency_overrides[get_db] = database
        self.client = TestClient(app)

    def tearDown(self):
        app.dependency_overrides.pop(get_db, None)
        self.client.close()

    def login(self, username, password):
        return self.client.post("/api/v1/auth/login", data={"username": username, "password": password})

    def subject(self, response):
        return jwt.decode(response.json()["access_token"], settings.SECRET_KEY,
                          algorithms=[security.ALGORITHM])["sub"]

    def test_admin_alias_still_verifies_its_own_password(self):
        response = self.login("admin", self.human_password)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.subject(response), "human-admin")
        self.assertEqual(self.db.lookups, [CDS_ADMIN_EMAIL])
        self.assertEqual(self.login("admin", self.service_password).status_code, 400)

    def test_service_email_authenticates_the_machine_account(self):
        response = self.login("cds-review@example.com", self.service_password)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.subject(response), "machine-service")
        self.assertEqual(self.db.lookups, ["cds-review@example.com"])

    def test_alias_does_not_expand_to_other_usernames(self):
        self.assertEqual(self.login("Admin", self.human_password).status_code, 400)
        self.assertEqual(self.db.lookups, ["Admin"])

    def test_projects_require_a_bearer_session(self):
        self.assertEqual(self.client.get("/api/v1/projects/").status_code, 401)
        self.assertEqual(self.db.lookups, [])


if __name__ == "__main__":
    unittest.main()
