from django.urls import include, path, re_path
from planner.views import spa_index

urlpatterns = [
    path("api/", include("planner.urls")),
    # Everything else is the React single-page app (served from the built bundle in production).
    re_path(r"^(?!api/|static/).*$", spa_index, name="spa"),
]
