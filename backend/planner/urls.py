from django.urls import path

from . import views

urlpatterns = [
    path("health", views.health, name="health"),
    path("meta", views.meta, name="meta"),
    path("geocode", views.geocode, name="geocode"),
    path("plan", views.plan, name="plan"),
    path("plans/<str:plan_id>/heatmap", views.heatmap, name="heatmap"),
]
